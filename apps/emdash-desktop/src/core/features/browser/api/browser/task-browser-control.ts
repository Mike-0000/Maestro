import { action, makeObservable, observable, reaction, runInAction } from 'mobx';
import {
  BROWSER_ISOLATED_PROFILE_ID,
  httpOrigin,
  isIsolatedBrowserPartition,
} from '@core/primitives/browser/api';
import { log } from '@core/primitives/logging/browser/logger';
import { browserSessionStore } from './browser-session-store';
import { browserUserOrigins } from './browser-user-origins';
import { getBrowserClient } from './client';

export type TaskBrowserControl = 'user' | 'agents';

/**
 * Who drives each browser tab in a task's own view, and its registration with main's agent
 * control. A task-view tab is one of its task's browsers: main points the task's agents at the
 * one the developer looked at last, so they see and use the tab beside the chat rather than a
 * canvas tile nobody is looking at.
 *
 * Security: a tab on the developer's own profile is registered as `user` only, so agents can be
 * told it is the browser in use; main never reads or drives it. Handing a tab to agents moves it
 * to the task's isolated profile first (the developer's logins stay behind), and main checks the
 * partition again on every call.
 */
export class TaskBrowserControlStore {
  readonly controls = observable.map<string, TaskBrowserControl>();

  constructor() {
    makeObservable(this, { setControl: action });
  }

  control(browserId: string): TaskBrowserControl {
    return this.controls.get(browserId) ?? 'user';
  }

  setControl(browserId: string, control: TaskBrowserControl): void {
    this.controls.set(browserId, control);
  }

  /**
   * Keeps main's registration of a task-view tab current (its partition, the local origin it
   * shows, who drives it) until the returned disposer runs, which forgets it in main.
   */
  track(browserId: string, initial: TaskBrowserControl): () => void {
    this.controls.set(browserId, initial);
    const dispose = reaction(
      () => {
        const session = browserSessionStore.getSession(browserId);
        return session
          ? [
              session.partition,
              browserUserOrigins.get(browserId).join(','),
              this.control(browserId),
            ].join('|')
          : null;
      },
      (key) => {
        if (key !== null) void this.sync(browserId);
      },
      { fireImmediately: true }
    );
    return () => {
      dispose();
      this.controls.delete(browserId);
      void getBrowserClient().then((client) => client.forgetControl({ browserId }));
    };
  }

  /**
   * Hands a task-view tab to agents: moves it to the task's isolated profile if it is on the
   * developer's own one, then tells main. False when main refused.
   *
   * What the tab showed on the developer's profile stays theirs: it may be a capability URL (a
   * magic or signed link) that would work again on the isolated profile. So the moved tab keeps
   * its page only when it is on one of the task's dev servers (`devServerUrls`); otherwise it
   * opens the first dev server, or a blank page.
   */
  async handOver(browserId: string, devServerUrls: readonly string[] = []): Promise<boolean> {
    const session = browserSessionStore.getSession(browserId);
    if (!session) return false;
    runInAction(() => {
      if (!isIsolatedBrowserPartition(session.partition)) {
        const origin = httpOrigin(session.currentUrl);
        const onDevServer = devServerUrls.some((url) => httpOrigin(url) === origin);
        const url = onDevServer ? session.currentUrl : (devServerUrls[0] ?? 'about:blank');
        browserSessionStore.setSessionProfile(browserId, BROWSER_ISOLATED_PROFILE_ID);
        // Origins the developer opened on their own profile were not opened for agents.
        browserUserOrigins.forget(browserId);
        browserSessionStore.updateSession(browserId, {
          currentUrl: url,
          title: '',
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
        });
      }
      this.setControl(browserId, 'agents');
    });
    return this.sync(browserId);
  }

  /** The developer takes a tab back from agents; main ends any agent lease on it. */
  takeBack(browserId: string): void {
    this.setControl(browserId, 'user');
  }

  /** Registers the tab's current partition and control with main. False when main refused. */
  async sync(browserId: string): Promise<boolean> {
    const session = browserSessionStore.getSession(browserId);
    if (!session) return false;
    const isolated = isIsolatedBrowserPartition(session.partition);
    // The developer moved an agents tab back to their own profile: it is theirs again.
    if (!isolated && this.control(browserId) === 'agents') this.setControl(browserId, 'user');
    const control = this.control(browserId);
    const client = await getBrowserClient();
    const registered = await client.registerSession({
      browserId,
      partition: session.partition,
    });
    if (!registered.success) return false;
    const origins = [...browserUserOrigins.get(browserId)];
    const result = await client.setControl({
      browserId,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      taskId: session.taskId,
      control,
      surface: 'task-view',
      ...(origins.length > 0 ? { origins } : {}),
    });
    if (!result.success) {
      log.warn('task-browser-control: setControl failed', { error: result.error });
      if (control === 'agents') this.setControl(browserId, 'user');
      return false;
    }
    return true;
  }
}

export const taskBrowserControl = new TaskBrowserControlStore();
