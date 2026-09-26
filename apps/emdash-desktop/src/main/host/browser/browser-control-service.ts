import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import type { WebContents } from 'electron';
import type { CanvasBrowserSettings } from '@core/features/canvas/contributions/settings';
import {
  describeNavigationDenial,
  evaluateNavigation,
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
} from '@core/primitives/browser/api';
import type { BrowserAutomation } from './browser-automation';
import type { BrowserConsoleBuffer } from './browser-console-buffer';
import type { BrowserWebContentsRegistry } from './browser-webcontents-registry';

/**
 * Policy gate for model-driven browsing. Every conductor and agent call passes through here:
 * the browser must be an isolated-per-task tile, the actor must be allowed (conductor setting, or
 * an agent scoped to that same task), navigation stays on the task's dev-server origins, and calls
 * are rate limited. Acting needs the tile handed to agents; an agent may also watch (screenshot,
 * outline, text, console) its own task's tile while the user drives it, since watching changes
 * nothing. While a model holds the control lease, navigations the page starts on its own are held
 * to the same origin policy.
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
};

type ControlEntry = BrowserTaskIdentity & {
  browserId: string;
  control: BrowserControl;
  origins: string[];
  lease: { actorKey: string; actor: BrowserAutomationActor; until: number } | null;
};

type OpenAnswer = { browserId: string | null; denial?: BrowserOpenDenial };

type PendingOpen = {
  resolve: (answer: OpenAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type BrowserControlDeps = {
  registry: Pick<BrowserWebContentsRegistry, 'getBoundWebContents' | 'getPartition' | 'onBinding'>;
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
        deps.consoleBuffer.attach(event.browserId, event.webContents);
        this.installNavigationGuards(event.browserId, event.webContents);
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
   * A task's canvas browser, if one is registered. `control` finds only a tile handed to agents;
   * `observe` also finds the tile while the user drives it (always an isolated partition).
   */
  findTaskBrowser(taskId: string, access: BrowserOpenAccess = 'control'): string | null {
    let observable: string | null = null;
    for (const entry of this.entries.values()) {
      if (entry.taskId !== taskId) continue;
      if (entry.control === 'agents') return entry.browserId;
      if (access === 'observe' && observable === null && this.isIsolated(entry.browserId)) {
        observable = entry.browserId;
      }
    }
    return observable;
  }

  describeTaskBrowser(taskId: string): {
    browserId: string;
    url: string | null;
    live: boolean;
    control: BrowserControl;
    allowedOrigins: string[];
  } | null {
    const browserId = this.findTaskBrowser(taskId, 'observe');
    const entry = browserId ? this.entries.get(browserId) : undefined;
    if (!browserId || !entry) return null;
    const webContents = this.deps.registry.getBoundWebContents(browserId);
    return {
      browserId,
      url: webContents?.getURL() ?? null,
      live: webContents !== null,
      control: entry.control,
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
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        url,
        actor: publicActor(scope),
        access,
      });
    });
    if (!answer.browserId) return err(openDenied(answer.denial));
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
    const { entry, webContents } = authorized.data;
    const action = input.action;
    if (action.kind === 'navigate') {
      const decision = evaluateNavigation(action.url, this.policy(entry));
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
    this.busy.add(entry.browserId);
    const actorKey = actorKeyOf(scope);
    entry.lease = {
      actorKey,
      actor: publicActor(scope),
      until: this.now() + CONTROL_LEASE_MS,
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
  ): Promise<Result<{ entry: ControlEntry; webContents: WebContents }, BrowserAutomationError>> {
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
        message: 'The browser is not live right now (suspended or its canvas is closed).',
      });
    }
    return ok({ entry, webContents });
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
      projectId: entry.projectId,
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      url: null,
      actor: publicActor(scope),
      access,
    });
    const deadline = this.now() + BIND_TIMEOUT_MS;
    while (this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const webContents = this.deps.registry.getBoundWebContents(entry.browserId);
      if (webContents) {
        // A freshly attached guest needs its first load before it can be read.
        if (webContents.isLoading()) await waitForStop(webContents, 5_000);
        return webContents;
      }
    }
    return null;
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

  private policy(entry: ControlEntry) {
    return { allowedOrigins: this.allowedOrigins(entry), reservedPorts: this.deps.reservedPorts() };
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
      const decision = evaluateNavigation(url, this.policy(entry));
      if (decision.ok) return;
      event.preventDefault();
      this.deps.consoleBuffer.push(browserId, {
        level: 'warning',
        message: `Chorus blocked navigation to ${url} while a model controls this browser.`,
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

function openDenied(denial: BrowserOpenDenial | undefined): BrowserAutomationError {
  switch (denial) {
    case 'disabled':
      return { type: 'disabled', message: 'Canvas browsers are turned off in Chorus settings.' };
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
          'Chorus asked the user to let agents use the app browser and is waiting for an answer. Watching works meanwhile; retry open_app once they allow it.',
      };
    default:
      return {
        type: 'not-bound',
        message:
          'Chorus did not open a browser for this task. The Chorus window may be closed or still starting; retry shortly.',
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
