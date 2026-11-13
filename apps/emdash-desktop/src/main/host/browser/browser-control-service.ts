import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import type { WebContents } from 'electron';
import type { CanvasBrowserSettings } from '@core/features/canvas/contributions/settings';
import {
  describeNavigationDenial,
  evaluateNavigation,
  evaluatePublicUrl,
  isIsolatedBrowserPartition,
  originKey,
  SlidingWindowLimiter,
  type BrowserActInput,
  type BrowserActResult,
  type BrowserAutomationActor,
  type BrowserAutomationError,
  type BrowserConsoleEntry,
  type BrowserEvent,
  type BrowserObservation,
  type BrowserObserveInput,
  type BrowserOpenAccess,
  type BrowserOpenDenial,
  type BrowserSurfaceKind,
  type NavigationPolicy,
} from '@core/primitives/browser/api';
import type { BrowserAutomation } from './browser-automation';
import type { BrowserConsoleBuffer } from './browser-console-buffer';
import type { BrowserWebContentsRegistry } from './browser-webcontents-registry';

/**
 * Policy gate for model-driven browsing. Every conductor and agent call passes through here:
 * the browser must be an isolated-per-task tile, the actor must be allowed (conductor setting, or
 * an agent scoped to that same task), navigation stays on the task's dev-server origins, and calls
 * are rate limited. The conductor alone may also load public https origins, when the setting is on
 * and the user approved that origin for the tile. Acting needs the tile handed to agents; an agent may also watch (screenshot,
 * outline, text, console) its own task's tile while the user drives it, since watching changes
 * nothing. While a model holds the control lease, navigations the page starts on its own are held
 * to the same origin policy.
 *
 * A task can have several browsers: its canvas tile and browser tabs in its own view. Agents use
 * the one the developer looked at last that still has a page (see `primaryEntry`), so they drive
 * what the developer sees, never a copy hidden elsewhere. A browser on the developer's own profile
 * is registered too, only so that agents are told it is the one in use; it is never read or driven.
 */

export type BrowserControl = 'user' | 'agents';

export type BrowserTaskIdentity = { projectId: string; workspaceId: string; taskId: string };

/** Main-internal actor scope: agents carry the task their token was minted for. */
export type BrowserActorScope =
  | { kind: 'conductor' }
  | ({ kind: 'agent'; conversationId: string; name?: string } & BrowserTaskIdentity);

export type SetBrowserControlInput = BrowserTaskIdentity & {
  browserId: string;
  control: BrowserControl;
  /** Origins the user opened in this tile, admitted alongside dev-server origins. */
  origins?: string[];
  /** Public origins the user approved for the conductor in this tile. */
  publicOrigins?: string[];
  /** Where the browser is shown (default: a canvas tile). */
  surface?: BrowserSurfaceKind;
};

type ControlEntry = BrowserTaskIdentity & {
  browserId: string;
  control: BrowserControl;
  origins: string[];
  publicOrigins: string[];
  surface: BrowserSurfaceKind;
  lease: {
    actorKey: string;
    actor: BrowserAutomationActor;
    until: number;
    /** The lease holder may be on approved public origins (conductor, setting on). */
    publicWeb: boolean;
  } | null;
};

type OpenAnswer = { browserId: string | null; denial?: BrowserOpenDenial };

type PendingOpen = {
  resolve: (answer: OpenAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BindWaiter = (webContents: WebContents | null) => void;

export type BrowserControlDeps = {
  registry: Pick<
    BrowserWebContentsRegistry,
    'getBoundWebContents' | 'getPartition' | 'onBinding' | 'getShownAt' | 'isIsolatedGuest'
  >;
  automation: Pick<BrowserAutomation, 'observe' | 'act' | 'release'>;
  consoleBuffer: Pick<
    BrowserConsoleBuffer,
    'tail' | 'attach' | 'detachWebContents' | 'forget' | 'push'
  >;
  emit: (event: BrowserEvent) => void;
  getSettings: () => Promise<CanvasBrowserSettings>;
  /** Dev-server URLs detected for a workspace. */
  listDevServerUrls: (identity: { projectId: string; workspaceId: string }) => string[];
  reservedPorts: () => readonly number[];
  now?: () => number;
};

export const CONTROL_LEASE_MS = 60_000;
/** Covers the renderer asking the user to hand a tile to agents (it answers within 25 s). */
const OPEN_REQUEST_TIMEOUT_MS = 30_000;
const BIND_TIMEOUT_MS = 10_000;
const ACT_LIMIT = { count: 30, windowMs: 10_000 };
const OBSERVE_LIMIT = { count: 20, windowMs: 10_000 };

export class BrowserControlService {
  private readonly entries = new Map<string, ControlEntry>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  /** Calls waiting for a browser's webview to attach, by browser id. */
  private readonly bindWaiters = new Map<string, Set<BindWaiter>>();
  private readonly busy = new Set<string>();
  private readonly guardsByWebContentsId = new Map<number, () => void>();
  private readonly now: () => number;
  private readonly actLimiter: SlidingWindowLimiter;
  private readonly observeLimiter: SlidingWindowLimiter;

  constructor(private readonly deps: BrowserControlDeps) {
    this.now = deps.now ?? Date.now;
    this.actLimiter = new SlidingWindowLimiter(ACT_LIMIT.count, ACT_LIMIT.windowMs, this.now);
    this.observeLimiter = new SlidingWindowLimiter(
      OBSERVE_LIMIT.count,
      OBSERVE_LIMIT.windowMs,
      this.now
    );
    deps.registry.onBinding((event) => {
      if (event.type === 'bound') {
        // Console output of a page on the developer's own profile is never kept for models.
        if (deps.registry.isIsolatedGuest(event.browserId, event.webContents)) {
          deps.consoleBuffer.attach(event.browserId, event.webContents);
        }
        this.installNavigationGuards(event.browserId, event.webContents);
        const waiters = this.bindWaiters.get(event.browserId);
        this.bindWaiters.delete(event.browserId);
        for (const wake of waiters ?? []) wake(event.webContents);
      } else {
        deps.consoleBuffer.detachWebContents(event.webContentsId);
        this.guardsByWebContentsId.get(event.webContentsId)?.();
        this.guardsByWebContentsId.delete(event.webContentsId);
      }
    });
  }

  setControl(input: SetBrowserControlInput): Result<void, BrowserAutomationError> {
    const partition = this.deps.registry.getPartition(input.browserId);
    if (!partition) return err({ type: 'not-bound', message: 'Unknown browser.' });
    if (input.control === 'agents' && !isIsolatedBrowserPartition(partition)) {
      return err({
        type: 'not-controllable',
        message: 'Only isolated per-task browsers can be handed to agents.',
      });
    }
    const previous = this.entries.get(input.browserId);
    const entry: ControlEntry = {
      browserId: input.browserId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      control: input.control,
      origins: (input.origins ?? []).filter((origin) => originKey(origin) !== null).slice(0, 16),
      publicOrigins: (input.publicOrigins ?? [])
        .map((origin) => evaluatePublicUrl(origin))
        .flatMap((decision) => (decision.ok ? [decision.origin] : []))
        .slice(0, 16),
      surface: input.surface ?? 'canvas',
      lease: input.control === 'agents' ? (previous?.lease ?? null) : null,
    };
    this.entries.set(input.browserId, entry);
    if (input.control === 'user') {
      const webContents = this.deps.registry.getBoundWebContents(input.browserId);
      if (webContents) this.deps.automation.release(webContents);
      if (previous?.lease) this.emitLease(entry, previous.lease.actor, 'released', true);
    }
    return ok(undefined);
  }

  /** Called when the renderer closes a browser for good. */
  forget(browserId: string): void {
    this.entries.delete(browserId);
    this.deps.consoleBuffer.forget(browserId);
    this.actLimiter.forget(browserId);
    this.observeLimiter.forget(browserId);
  }

  /** Stops the model's control lease without taking the browser away from agents. */
  stopLease(browserId: string): void {
    const entry = this.entries.get(browserId);
    if (!entry?.lease) return;
    const actor = entry.lease.actor;
    entry.lease = null;
    this.emitLease(entry, actor, 'stopped by user', true);
  }

  /**
   * The task's browser agents use: the one the developer looked at last among those with a live
   * page, else the one looked at last (it is brought back on use). Ties keep registration order,
   * so a task with only its canvas tile behaves as before.
   */
  private primaryEntry(taskId: string): ControlEntry | null {
    let best: { entry: ControlEntry; live: boolean; shownAt: number } | null = null;
    for (const entry of this.entries.values()) {
      if (entry.taskId !== taskId) continue;
      const live = this.deps.registry.getBoundWebContents(entry.browserId) !== null;
      const shownAt = this.deps.registry.getShownAt(entry.browserId);
      if (!best || (live && !best.live) || (live === best.live && shownAt > best.shownAt)) {
        best = { entry, live, shownAt };
      }
    }
    return best?.entry ?? null;
  }

  /**
   * The task's browser for agents (see `primaryEntry`), when agents may use it: `observe` needs
   * an isolated partition, `control` also needs it handed to agents. Null otherwise; acting then
   * asks the renderer (and the developer) to hand that same browser over, never another one.
   */
  findTaskBrowser(taskId: string, access: BrowserOpenAccess = 'control'): string | null {
    const entry = this.primaryEntry(taskId);
    if (!entry || !this.isIsolated(entry.browserId)) return null;
    if (access === 'control' && entry.control !== 'agents') return null;
    return entry.browserId;
  }

  /**
   * What agents are told about the task's browser. A browser on the developer's own profile is
   * described only by where it is: its page and address are not shared with agents.
   */
  describeTaskBrowser(taskId: string): {
    browserId: string;
    url: string | null;
    live: boolean;
    control: BrowserControl;
    surface: BrowserSurfaceKind;
    isolated: boolean;
    allowedOrigins: string[];
  } | null {
    const entry = this.primaryEntry(taskId);
    if (!entry) return null;
    const isolated = this.isIsolated(entry.browserId);
    const webContents = this.deps.registry.getBoundWebContents(entry.browserId);
    return {
      browserId: entry.browserId,
      url: isolated ? (webContents?.getURL() ?? null) : null,
      live: webContents !== null,
      control: entry.control,
      surface: entry.surface,
      isolated,
      allowedOrigins: this.allowedOrigins(entry),
    };
  }

  /**
   * Asks the renderer to open (or resume) the task's controllable canvas browser and resolves
   * with its id once the renderer answers. Used by agents, which cannot mount webviews.
   */
  async requestOpen(
    scope: BrowserActorScope & { kind: 'agent' },
    url: string | null,
    access: BrowserOpenAccess = 'control'
  ): Promise<Result<string, BrowserAutomationError>> {
    const settings = await this.deps.getSettings();
    const denied = this.actorDenied(scope, settings);
    if (denied) return err(denied);
    if (url) {
      // The renderer loads this URL without asking again: hold it to the task's origins now.
      const entryId = this.findTaskBrowser(scope.taskId, 'observe');
      const entry = entryId ? this.entries.get(entryId) : undefined;
      const decision = evaluateNavigation(url, {
        allowedOrigins: entry ? this.allowedOrigins(entry) : this.devServerOrigins(scope),
        reservedPorts: this.deps.reservedPorts(),
      });
      if (!decision.ok) {
        return err({
          type: 'origin-denied',
          url,
          message: describeNavigationDenial(decision, url),
        });
      }
    }
    const requestId = randomUUID();
    const answer = await new Promise<OpenAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(requestId);
        resolve({ browserId: null });
      }, OPEN_REQUEST_TIMEOUT_MS);
      this.pendingOpens.set(requestId, { resolve, timer });
      this.deps.emit({
        type: 'open-request',
        requestId,
        browserId: this.primaryEntry(scope.taskId)?.browserId ?? null,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        url,
        actor: publicActor(scope),
        access,
      });
    });
    if (!answer.browserId) return err(openDenied(answer.denial));
    // The ack only says a tile exists; agents can use it once its webview has attached.
    const opened = await this.waitForBinding(answer.browserId);
    if (opened && !this.deps.registry.isIsolatedGuest(answer.browserId, opened)) {
      return err(ownProfileError());
    }
    if (!opened) {
      return err({
        type: 'not-bound',
        message:
          "Maestro put the app browser on the canvas, but its page did not come up, so agents cannot see or use it yet. Check that the Maestro window is open, start the task's dev server if it is not running, then call open_app again.",
      });
    }
    return ok(answer.browserId);
  }

  ackOpenRequest(requestId: string, browserId: string | null, denial?: BrowserOpenDenial): void {
    const pending = this.pendingOpens.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOpens.delete(requestId);
    pending.resolve({ browserId, ...(denial ? { denial } : {}) });
  }

  async observe(
    scope: BrowserActorScope,
    input: BrowserObserveInput
  ): Promise<Result<BrowserObservation, BrowserAutomationError>> {
    const authorized = await this.authorize(scope, input.browserId, 'observe');
    if (!authorized.success) return authorized;
    const { entry, webContents } = authorized.data;
    // Re-checked last: the browser may have moved to another profile while the call waited.
    if (!this.deps.registry.isIsolatedGuest(input.browserId, webContents)) {
      return err(ownProfileError());
    }
    const result = await this.deps.automation.observe(webContents, input);
    if (result.success && input.includeConsole) {
      result.data.console = this.deps.consoleBuffer.tail(input.browserId, 15);
    }
    this.emitAutomation(entry, scope, `observe:${input.mode}`, result.success);
    return result;
  }

  async act(
    scope: BrowserActorScope,
    input: BrowserActInput
  ): Promise<Result<BrowserActResult, BrowserAutomationError>> {
    const authorized = await this.authorize(scope, input.browserId, 'act');
    if (!authorized.success) return authorized;
    const { entry, webContents, settings } = authorized.data;
    const action = input.action;
    const publicWeb = scope.kind === 'conductor' ? settings.conductorPublicWeb : null;
    if (action.kind === 'navigate') {
      const decision = evaluateNavigation(action.url, this.policy(entry, publicWeb));
      if (!decision.ok) {
        this.emitAutomation(entry, scope, 'navigate', false, 'blocked');
        return err({
          type: 'origin-denied',
          url: action.url,
          message: describeNavigationDenial(decision, action.url),
        });
      }
    }
    if (this.busy.has(entry.browserId)) {
      return err({ type: 'busy', message: 'Another action is still running in this browser.' });
    }
    // Re-checked last: the browser may have moved to another profile while the call waited.
    if (!this.deps.registry.isIsolatedGuest(input.browserId, webContents)) {
      return err(ownProfileError());
    }
    this.busy.add(entry.browserId);
    const actorKey = actorKeyOf(scope);
    entry.lease = {
      actorKey,
      actor: publicActor(scope),
      until: this.now() + CONTROL_LEASE_MS,
      publicWeb: publicWeb === true,
    };
    try {
      const result = await this.deps.automation.act(webContents, action);
      if (entry.lease?.actorKey === actorKey) entry.lease.until = this.now() + CONTROL_LEASE_MS;
      this.emitAutomation(
        entry,
        scope,
        action.kind,
        result.success,
        result.success ? undefined : result.error.type
      );
      return result;
    } finally {
      this.busy.delete(entry.browserId);
    }
  }

  async consoleTail(
    scope: BrowserActorScope,
    browserId: string,
    limit: number
  ): Promise<Result<BrowserConsoleEntry[], BrowserAutomationError>> {
    const authorized = await this.authorize(scope, browserId, 'observe', { requireLive: false });
    if (!authorized.success) return authorized;
    return ok(this.deps.consoleBuffer.tail(browserId, limit, 'info'));
  }

  allowedOriginsFor(browserId: string): string[] {
    const entry = this.entries.get(browserId);
    return entry ? this.allowedOrigins(entry) : [];
  }

  private async authorize(
    scope: BrowserActorScope,
    browserId: string,
    kind: 'observe' | 'act',
    options: { requireLive?: boolean } = {}
  ): Promise<
    Result<
      { entry: ControlEntry; webContents: WebContents; settings: CanvasBrowserSettings },
      BrowserAutomationError
    >
  > {
    const settings = await this.deps.getSettings();
    const denied = this.actorDenied(scope, settings);
    if (denied) return err(denied);
    const entry = this.entries.get(browserId);
    // Agents may watch their own task's isolated tile while the user drives it; acting (and the
    // conductor, which is not task-scoped) needs the tile handed to agents.
    const watchOnly = kind === 'observe' && scope.kind === 'agent';
    if (!entry || !this.isIsolated(browserId) || (entry.control !== 'agents' && !watchOnly)) {
      return err({
        type: 'not-controllable',
        message:
          'The user is driving this browser (its tile is set to "You"). Call open_app to ask them to hand it to agents; look_at_app and app_screenshot still work meanwhile.',
      });
    }
    if (scope.kind === 'agent' && scope.taskId !== entry.taskId) {
      return err({
        type: 'not-controllable',
        message: 'Agents can only use the browser of their own task.',
      });
    }
    if (kind === 'observe' && scope.kind === 'conductor' && !settings.sendPageContentToModel) {
      return err({
        type: 'disabled',
        message: 'Sending page content to the conductor model is turned off in settings.',
      });
    }
    const actorKey = actorKeyOf(scope);
    // Reading never conflicts with another actor's lease; only acting waits it out.
    if (
      kind === 'act' &&
      entry.lease &&
      entry.lease.until > this.now() &&
      entry.lease.actorKey !== actorKey
    ) {
      return err({
        type: 'busy',
        message: `${actorLabel(entry.lease.actor)} is using this browser right now.`,
      });
    }
    const limiter = kind === 'act' ? this.actLimiter : this.observeLimiter;
    if (!limiter.tryAcquire(`${browserId}:${actorKey}`)) {
      return err({ type: 'rate-limited', message: 'Too many browser calls; slow down.' });
    }
    const webContents = await this.liveWebContents(
      entry,
      scope,
      options.requireLive ?? true,
      kind === 'act' ? 'control' : 'observe'
    );
    if (!webContents) {
      return err({
        type: 'not-bound',
        message:
          'The app browser is not live right now (suspended, closed, or its page did not come up). Call open_app to bring it back, then retry.',
      });
    }
    return ok({ entry, webContents, settings });
  }

  /** A bound webContents, asking the renderer to resume a suspended tile if needed. */
  private async liveWebContents(
    entry: ControlEntry,
    scope: BrowserActorScope,
    requireLive: boolean,
    access: BrowserOpenAccess
  ): Promise<WebContents | null> {
    const bound = this.deps.registry.getBoundWebContents(entry.browserId);
    if (bound || !requireLive) return bound;
    this.deps.emit({
      type: 'open-request',
      requestId: randomUUID(),
      browserId: entry.browserId,
      projectId: entry.projectId,
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      url: null,
      actor: publicActor(scope),
      access,
    });
    return this.waitForBinding(entry.browserId);
  }

  /**
   * The browser's webContents once its webview attaches (now, or within the bind timeout), after
   * its first load; null if it never attaches.
   */
  private async waitForBinding(browserId: string): Promise<WebContents | null> {
    let webContents = this.deps.registry.getBoundWebContents(browserId);
    if (!webContents) {
      webContents = await new Promise<WebContents | null>((resolve) => {
        const waiters = this.bindWaiters.get(browserId) ?? new Set<BindWaiter>();
        const wake: BindWaiter = (bound) => {
          clearTimeout(timer);
          waiters.delete(wake);
          if (waiters.size === 0 && this.bindWaiters.get(browserId) === waiters) {
            this.bindWaiters.delete(browserId);
          }
          resolve(bound);
        };
        const timer = setTimeout(() => wake(null), BIND_TIMEOUT_MS);
        waiters.add(wake);
        this.bindWaiters.set(browserId, waiters);
      });
    }
    // A freshly attached guest needs its first load before it can be read.
    if (webContents && !webContents.isDestroyed() && webContents.isLoading()) {
      await waitForStop(webContents, 5_000);
    }
    return webContents && !webContents.isDestroyed() ? webContents : null;
  }

  private actorDenied(
    scope: BrowserActorScope,
    settings: CanvasBrowserSettings
  ): BrowserAutomationError | null {
    if (!settings.enabled) return { type: 'disabled', message: 'Canvas browsers are turned off.' };
    if (scope.kind === 'conductor' && !settings.conductorControl) {
      return { type: 'disabled', message: 'Conductor browser control is turned off in settings.' };
    }
    if (scope.kind === 'agent' && !settings.agentControl) {
      return { type: 'disabled', message: 'Agent browser control is turned off in settings.' };
    }
    return null;
  }

  private isIsolated(browserId: string): boolean {
    const partition = this.deps.registry.getPartition(browserId);
    return partition !== null && isIsolatedBrowserPartition(partition);
  }

  /**
   * `publicWeb` is the conductor's public-web setting, or null for an actor that never gets
   * public websites (coding agents).
   */
  private policy(entry: ControlEntry, publicWeb: boolean | null = null): NavigationPolicy {
    return {
      allowedOrigins: this.allowedOrigins(entry),
      reservedPorts: this.deps.reservedPorts(),
      ...(publicWeb === null
        ? {}
        : { publicWeb: publicWeb ? { approvedOrigins: entry.publicOrigins } : 'disabled' }),
    };
  }

  private allowedOrigins(entry: ControlEntry): string[] {
    return [...new Set([...entry.origins, ...this.devServerOrigins(entry)])];
  }

  private devServerOrigins(identity: { projectId: string; workspaceId: string }): string[] {
    const origins: string[] = [];
    for (const url of this.deps.listDevServerUrls(identity)) {
      try {
        origins.push(new URL(url).origin);
      } catch {
        // Skip malformed detections.
      }
    }
    return origins;
  }

  /**
   * While a model holds the lease, the page may not leave the allowed origins on its own
   * (a click on an external link, a redirect). The user browsing freely is unaffected.
   */
  private installNavigationGuards(browserId: string, webContents: WebContents): void {
    const leased = () => {
      const entry = this.entries.get(browserId);
      if (!entry || entry.control !== 'agents' || !entry.lease) return null;
      return entry.lease.until > this.now() ? entry : null;
    };
    const guard = (event: { preventDefault(): void }, url: string) => {
      const entry = leased();
      if (!entry) return;
      const decision = evaluateNavigation(
        url,
        this.policy(entry, entry.lease?.publicWeb ? true : null)
      );
      if (decision.ok) return;
      event.preventDefault();
      this.deps.consoleBuffer.push(browserId, {
        level: 'warning',
        message: `Maestro blocked navigation to ${url} while a model controls this browser.`,
      });
      this.emitAutomation(entry, { kind: 'conductor' }, 'navigation-blocked', false, url, {
        actor: entry.lease?.actor,
      });
    };
    const onWillNavigate = (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>) =>
      guard(event, event.url);
    const onWillRedirect = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      if (event.isMainFrame) guard(event, event.url);
    };
    webContents.on('will-navigate', onWillNavigate);
    webContents.on('will-redirect', onWillRedirect);
    this.guardsByWebContentsId.set(webContents.id, () => {
      if (webContents.isDestroyed()) return;
      webContents.off('will-navigate', onWillNavigate);
      webContents.off('will-redirect', onWillRedirect);
    });
  }

  private emitAutomation(
    entry: ControlEntry,
    scope: BrowserActorScope,
    action: string,
    ok: boolean,
    detail?: string,
    overrides: { actor?: BrowserAutomationActor } = {}
  ): void {
    this.deps.emit({
      type: 'automation',
      browserId: entry.browserId,
      actor: overrides.actor ?? publicActor(scope),
      action,
      ok,
      ...(detail ? { detail } : {}),
      ...(entry.lease && entry.lease.until > this.now() ? { leaseUntil: entry.lease.until } : {}),
    });
  }

  private emitLease(
    entry: ControlEntry,
    actor: BrowserAutomationActor,
    detail: string,
    okValue: boolean
  ): void {
    this.deps.emit({
      type: 'automation',
      browserId: entry.browserId,
      actor,
      action: 'lease',
      ok: okValue,
      detail,
    });
  }
}

function ownProfileError(): BrowserAutomationError {
  return {
    type: 'not-controllable',
    message:
      "This browser is now on the developer's own profile, so agents cannot see or use it. Call open_app to ask for the task's app browser again.",
  };
}

function openDenied(denial: BrowserOpenDenial | undefined): BrowserAutomationError {
  switch (denial) {
    case 'disabled':
      return { type: 'disabled', message: 'Canvas browsers are turned off in Maestro settings.' };
    case 'declined':
      return {
        type: 'not-controllable',
        message:
          'The user kept control of the app browser. Watching still works (look_at_app, app_screenshot); ask them before trying again.',
      };
    case 'consent-pending':
      return {
        type: 'not-controllable',
        message:
          'Maestro asked the user to let agents use the app browser and is waiting for an answer. Watching works meanwhile; retry open_app once they allow it.',
      };
    default:
      return {
        type: 'not-bound',
        message:
          'Maestro did not open a browser for this task. The Maestro window may be closed or still starting; retry shortly.',
      };
  }
}

function publicActor(scope: BrowserActorScope): BrowserAutomationActor {
  return scope.kind === 'conductor'
    ? { kind: 'conductor' }
    : {
        kind: 'agent',
        conversationId: scope.conversationId,
        ...(scope.name ? { name: scope.name } : {}),
      };
}

function actorKeyOf(scope: BrowserActorScope): string {
  return scope.kind === 'conductor' ? 'conductor' : `agent:${scope.conversationId}`;
}

function actorLabel(actor: BrowserAutomationActor): string {
  return actor.kind === 'conductor' ? 'The conductor' : (actor.name ?? 'Another agent');
}

function waitForStop(webContents: WebContents, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      if (!webContents.isDestroyed()) webContents.off('did-stop-loading', done);
      resolve();
    }
    webContents.once('did-stop-loading', done);
  });
}
