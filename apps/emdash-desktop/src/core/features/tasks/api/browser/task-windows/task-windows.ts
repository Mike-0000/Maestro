import { computed, makeObservable, observable, action } from 'mobx';
import { log } from '@core/primitives/logging/browser/logger';
import { TASK_WINDOW_FRAME_PREFIX } from '../../task-window';
import { mirrorDocument } from './mirror-document';

/** A task popped out into its own window. */
export interface TaskWindow {
  readonly projectId: string;
  readonly taskId: string;
  /** The child window; it shares this renderer, so its document is ours to fill. */
  readonly window: Window;
  /** Where the task view is portalled, and where its menus and dialogs mount. */
  readonly container: HTMLElement;
}

/**
 * The tasks popped out into their own windows, at most one window per task. Each window is a
 * blank page opened from the main window; the task view renders into it through a React portal,
 * so it shares every store, its live models and its conductor with the main window.
 */
export class TaskWindowsStore {
  private readonly entries = observable.map<string, TaskWindow>([], { deep: false });
  private listening = false;

  constructor() {
    makeObservable<TaskWindowsStore, 'add' | 'remove'>(this, {
      windows: computed,
      add: action,
      remove: action,
    });
  }

  get windows(): TaskWindow[] {
    return [...this.entries.values()];
  }

  isOpen(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /** Opens the task in its own window, or brings its window to the front. */
  open(projectId: string, taskId: string): void {
    const existing = this.entries.get(taskId);
    if (existing && !existing.window.closed) {
      existing.window.focus();
      return;
    }
    this.listenForUnload();

    const child = window.open('', `${TASK_WINDOW_FRAME_PREFIX}${taskId}`, 'width=1280,height=860');
    if (!child) {
      log.warn('task window: the window could not be opened', { taskId });
      return;
    }
    const doc = child.document;
    const stopMirroring = mirrorDocument(document, doc);
    const sizing = doc.createElement('style');
    sizing.textContent = 'html, body { height: 100%; margin: 0; overflow: hidden; }';
    doc.head.appendChild(sizing);
    const container = doc.createElement('div');
    container.className = 'h-full w-full';
    doc.body.appendChild(container);

    // The child page goes away when the developer closes its window (or the main one reloads).
    child.addEventListener('pagehide', () => {
      stopMirroring();
      this.remove(taskId, child);
    });
    this.add({ projectId, taskId, window: child, container });
  }

  focus(taskId: string): void {
    this.entries.get(taskId)?.window.focus();
  }

  close(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.remove(taskId, entry.window);
    entry.window.close();
  }

  private add(entry: TaskWindow): void {
    this.entries.set(entry.taskId, entry);
  }

  private remove(taskId: string, child: Window): void {
    if (this.entries.get(taskId)?.window === child) this.entries.delete(taskId);
  }

  /** Task windows live in this page: they close with it rather than linger empty. */
  private listenForUnload(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('pagehide', () => {
      for (const entry of this.entries.values()) entry.window.close();
    });
  }
}

export const taskWindows = new TaskWindowsStore();
