import { toast } from '@emdash/ui/react/primitives';
import { action, comparer, makeObservable, observable, reaction, runInAction } from 'mobx';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import {
  DEFAULT_CANVAS_BROWSER_SETTINGS,
  type CanvasBrowserSettings,
} from '@core/features/canvas/contributions/settings';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  fetchAppSettingsMeta,
  getAppSettingValueSnapshot,
} from '@core/features/settings/api/browser/app-settings-client';
import { PreviewServerStore } from '@core/features/tasks/api/browser/stores/preview-server-store';
import { getLifecycleScriptsClient } from '@core/features/workspaces/api/browser/client';
import {
  BROWSER_ISOLATED_PROFILE_ID,
  httpOrigin,
  originKey,
  PREVIEW_SCREENSHOT_MAX_EDGE,
  type BrowserAutomationActor,
  type BrowserEvent,
} from '@core/primitives/browser/api';
import { log } from '@core/primitives/logging/browser/logger';
import { browsersToSuspend, type TileRect } from '../../canvas-model';
import type { BrowserTileEntry, CanvasStore } from './canvas-store';

/** Screen-space placement of a tile's page area, reported by the tile while the canvas shows it. */
export type BrowserSurfaceLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The page is shown live here (interactive zoom, fully in view). */
  live: boolean;
  /** Canvas chrome over the page (minimap, toolbar), relative to it; cut out of the live page. */
  holes: readonly TileRect[];
};

export type BrowserLease = { until: number; actor: BrowserAutomationActor };

const APP_START_TIMEOUT_MS = 90_000;
/** Matches the cap main applies to a browser's approved public origins. */
const MAX_PUBLIC_ORIGINS = 16;
/** How long an agent's request waits for the user's answer (main waits 30 s in total). */
const CONSENT_ANSWER_MS = 25_000;
/** The offer stays up longer; a late "Allow" still hands the tile over for the agent's retry. */
const CONSENT_TOAST_MS = 120_000;
const PREVIEW_REFRESH_MS = 2_500;

/**
 * Owns the canvas's app browsers outside React Flow: which webviews are alive, where each is
 * drawn, who drives it, and the task's dev server. Webviews render in `BrowserSurfaceHost` at the
 * workspace shell, so panning, node virtualization, and leaving the canvas never destroy a page.
 */
export class CanvasBrowserHost {
  /** Alive browsers in mount order. Order never changes: React must not move webview nodes. */
  alive: string[] = [];
  readonly layouts = observable.map<string, BrowserSurfaceLayout>();
  readonly leases = observable.map<string, BrowserLease>();
  /** Last model action per browser, for the tile's activity line. */
  readonly activity = observable.map<string, string>();
  /** Last capture per browser as a data URL, shown while the page is not live. */
  readonly previews = observable.map<string, string>();
  /** Tasks whose app is starting from the canvas ("Run app"). */
  readonly starting = observable.set<string>();
  /** Browsers in the sub-canvas the user is in: kept alive while it is focused. */
  pinned: ReadonlySet<string> = new Set();
  private readonly lastUsed = new Map<string, number>();
  private readonly servers = new Map<string, PreviewServerStore>();
  private readonly registered = new Set<string>();
  private readonly disposers: Array<() => void> = [];
  private readonly startTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Open consent prompts per task; concurrent agent requests share one prompt. */
  private readonly consents = new Map<string, Promise<boolean>>();
  /** Public origins the user approved for the conductor, per browser. Not kept across restarts. */
  private readonly publicOrigins = new Map<string, string[]>();
  private unsubscribeEvents: (() => void) | null = null;
  private settings: CanvasBrowserSettings = DEFAULT_CANVAS_BROWSER_SETTINGS;
  private disposed = false;

  constructor(private readonly canvas: CanvasStore) {
    makeObservable<CanvasBrowserHost, 'suspendOverBudget'>(this, {
      alive: observable.ref,
      pinned: observable.ref,
      setPinned: action,
      ensureAlive: action,
      suspend: action,
      placeSurface: action,
      suspendOverBudget: action,
    });
  }

  start(): void {
    void this.refreshSettings();
    void this.subscribe();
    this.disposers.push(
      // Entering a sub-canvas mounts every app browser in it, and keeps them mounted while the
      // user stays; leaving releases them to the usual most-recently-used budget.
      reaction(
        () => {
          const promoted = this.canvas.promotedSet;
          return this.canvas.browserEntries
            .filter((entry) => promoted.has(entry.tileId))
            .map((entry) => entry.browserId);
        },
        (ids) => this.setPinned(ids),
        { fireImmediately: true, equals: comparer.structural }
      ),
      // Sessions for every browser on the board; control synced whenever it changes.
      reaction(
        () => this.canvas.browserEntries.map((entry) => `${entry.browserId}:${entry.control}`),
        () => this.syncEntries(),
        { fireImmediately: true }
      ),
      // Persist the page each browser shows so it comes back after a restart.
      reaction(
        () =>
          this.canvas.browserEntries.map((entry) => {
            const session = browserSessionStore.getSession(entry.browserId);
            return [entry.taskId, session?.currentUrl, session?.title] as const;
          }),
        (rows) => {
          for (const [taskId, url, title] of rows) {
            if (url && url !== 'about:blank') this.canvas.setBrowserUrl(taskId, url, title);
          }
        }
      )
    );
    const timer = setInterval(() => this.refreshPreviews(), PREVIEW_REFRESH_MS);
    this.disposers.push(() => clearInterval(timer));
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.unsubscribeEvents?.();
    for (const store of this.servers.values()) store.dispose();
    this.servers.clear();
    for (const timer of this.startTimers.values()) clearTimeout(timer);
    for (const timer of this.leaseTimers.values()) clearTimeout(timer);
  }

  // ── Liveness ───────────────────────────────────────────────────────────────

  isAlive(browserId: string): boolean {
    return this.alive.includes(browserId);
  }

  isLeased(browserId: string): boolean {
    const lease = this.leases.get(browserId);
    return lease !== undefined && lease.until > Date.now();
  }

  /** Mounts a browser's webview (it keeps running while hidden) and records use. */
  ensureAlive(browserId: string): void {
    this.lastUsed.set(browserId, Date.now());
    if (!this.alive.includes(browserId)) this.alive = [...this.alive, browserId];
    this.suspendOverBudget();
  }

  /** Pins the focused sub-canvas's browsers (mounting them); unpinned ones become suspendable. */
  setPinned(browserIds: readonly string[]): void {
    this.pinned = new Set(browserIds);
    const missing = browserIds.filter((id) => !this.alive.includes(id));
    const now = Date.now();
    for (const id of browserIds) this.lastUsed.set(id, now);
    if (missing.length > 0) this.alive = [...this.alive, ...missing];
    this.suspendOverBudget();
  }

  touch(browserId: string): void {
    this.lastUsed.set(browserId, Date.now());
  }

  /** Unmounts a webview; the tile keeps its last capture. */
  suspend(browserId: string): void {
    if (!this.alive.includes(browserId)) return;
    this.alive = this.alive.filter((id) => id !== browserId);
    this.layouts.delete(browserId);
  }

  placeSurface(browserId: string, layout: BrowserSurfaceLayout | null): void {
    if (!layout) {
      this.layouts.delete(browserId);
      return;
    }
    const current = this.layouts.get(browserId);
    if (
      current &&
      current.left === layout.left &&
      current.top === layout.top &&
      current.width === layout.width &&
      current.height === layout.height &&
      current.live === layout.live &&
      sameRects(current.holes, layout.holes)
    ) {
      return;
    }
    this.layouts.set(browserId, layout);
    if (layout.live) this.touch(browserId);
  }

  private suspendOverBudget(): void {
    const leased = new Set(this.alive.filter((id) => this.isLeased(id)));
    const suspend = browsersToSuspend({
      alive: this.alive,
      lastUsed: this.lastUsed,
      leased,
      pinned: this.pinned,
      budget: this.settings.maxAliveBrowsers,
    });
    if (suspend.length === 0) return;
    const drop = new Set(suspend);
    this.alive = this.alive.filter((id) => !drop.has(id));
    for (const id of drop) this.layouts.delete(id);
  }

  // ── Browsers ───────────────────────────────────────────────────────────────

  /** Opens (or focuses) a task's app browser, starting on its dev server when one runs. */
  openForTask(
    input: { projectId: string; workspaceId: string; taskId: string; url?: string },
    options: { control?: BrowserTileEntry['control']; focus?: boolean } = {}
  ): string {
    const existing = this.canvas.browserForTask(input.taskId);
    const url = input.url ?? existing?.url ?? this.devServerUrls(input)[0] ?? 'about:blank';
    this.canvas.openBrowser({
      ...input,
      url,
      ...(options.control ? { control: options.control } : {}),
      focus: options.focus,
    });
    const entry = this.canvas.browserForTask(input.taskId);
    if (!entry) return '';
    this.ensureSession(entry);
    if (input.url && existing) {
      browserSessionStore.updateSession(entry.browserId, { currentUrl: input.url });
    }
    this.ensureAlive(entry.browserId);
    return entry.browserId;
  }

  async close(entry: BrowserTileEntry): Promise<void> {
    this.suspend(entry.browserId);
    this.canvas.closeBrowser(entry.taskId);
    browserSessionStore.removeSession(entry.browserId);
    this.registered.delete(entry.browserId);
    this.previews.delete(entry.browserId);
    this.leases.delete(entry.browserId);
    this.publicOrigins.delete(entry.browserId);
    const client = await getBrowserClient();
    await client.forgetControl({ browserId: entry.browserId });
    await client.unregisterSession({ browserId: entry.browserId });
  }

  async setControl(entry: BrowserTileEntry, control: BrowserTileEntry['control']): Promise<void> {
    this.canvas.setBrowserControl(entry.taskId, control);
    if (control === 'user') this.leases.delete(entry.browserId);
  }

  /** Sets who drives a browser and waits until main applied it. False when main refused. */
  async applyControl(
    entry: BrowserTileEntry,
    control: BrowserTileEntry['control']
  ): Promise<boolean> {
    await this.setControl(entry, control);
    const next = this.canvas.browserForTask(entry.taskId);
    if (!next) return false;
    await this.syncControl(next);
    return this.canvas.browserForTask(entry.taskId)?.control === control;
  }

  /** Whether the conductor may open public websites at all (the setting, read fresh). */
  async conductorPublicWebEnabled(): Promise<boolean> {
    await this.refreshSettings();
    const { enabled, conductorControl, conductorPublicWeb } = this.settings;
    return enabled && conductorControl && conductorPublicWeb;
  }

  publicOriginApproved(browserId: string, origin: string): boolean {
    return this.publicOrigins.get(browserId)?.includes(origin) ?? false;
  }

  /** Records the user's approval of a public origin for this browser and tells main. */
  async approvePublicOrigin(entry: BrowserTileEntry, origin: string): Promise<void> {
    const approved = this.publicOrigins.get(entry.browserId) ?? [];
    if (!approved.includes(origin)) {
      this.publicOrigins.set(entry.browserId, [...approved, origin].slice(-MAX_PUBLIC_ORIGINS));
    }
    await this.syncControl(entry);
  }

  async stopLease(browserId: string): Promise<void> {
    runInAction(() => this.leases.delete(browserId));
    const client = await getBrowserClient();
    await client.stopLease({ browserId });
  }

  private ensureSession(entry: BrowserTileEntry): void {
    if (browserSessionStore.getSession(entry.browserId)) return;
    browserSessionStore.createSession({
      projectId: entry.projectId,
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      browserId: entry.browserId,
      // Model-controllable browsers live in their own partition, never the user's profile.
      profileId: BROWSER_ISOLATED_PROFILE_ID,
      initialUrl: entry.url,
    });
  }

  private syncEntries(): void {
    const entries = this.canvas.browserEntries;
    const ids = new Set(entries.map((entry) => entry.browserId));
    runInAction(() => {
      for (const id of this.alive) if (!ids.has(id)) this.suspend(id);
    });
    for (const entry of entries) {
      this.ensureSession(entry);
      void this.syncControl(entry);
    }
  }

  private async syncControl(entry: BrowserTileEntry): Promise<void> {
    const session = browserSessionStore.getSession(entry.browserId);
    if (!session) return;
    const client = await getBrowserClient();
    if (!this.registered.has(entry.browserId)) {
      const registered = await client.registerSession({
        browserId: entry.browserId,
        partition: session.partition,
      });
      if (!registered.success) return;
      this.registered.add(entry.browserId);
    }
    // A local origin the user opened counts as theirs to share; remote origins must come from a
    // detected dev server (main adds those itself).
    const origin = httpOrigin(entry.url);
    const localOrigin = origin && originKey(origin)?.includes('//loopback:') ? origin : null;
    const result = await client.setControl({
      browserId: entry.browserId,
      projectId: entry.projectId,
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      control: entry.control,
      ...(localOrigin ? { origins: [localOrigin] } : {}),
      publicOrigins: this.publicOrigins.get(entry.browserId) ?? [],
    });
    if (!result.success) {
      log.warn('canvas-browser: setControl failed', { error: result.error });
      if (entry.control === 'agents') this.canvas.setBrowserControl(entry.taskId, 'user');
    }
  }

  // ── Previews ───────────────────────────────────────────────────────────────

  /** Captures browsers that are alive but not shown live, so their tiles stay current. */
  private refreshPreviews(): void {
    if (this.disposed) return;
    for (const browserId of this.alive) {
      const layout = this.layouts.get(browserId);
      if (layout?.live) continue;
      if (!layout && !this.isLeased(browserId) && this.previews.has(browserId)) continue;
      void this.capturePreview(browserId);
    }
  }

  async capturePreview(browserId: string): Promise<void> {
    const client = await getBrowserClient();
    const image = await client
      .capturePreview({ browserId, maxEdge: PREVIEW_SCREENSHOT_MAX_EDGE })
      .catch(() => null);
    if (!image) return;
    runInAction(() => {
      this.previews.set(browserId, `data:${image.mediaType};base64,${image.data}`);
    });
  }

  // ── Dev servers ────────────────────────────────────────────────────────────

  /** Dev-server URLs for a workspace; starts watching it on first use. */
  devServerUrls(input: { projectId: string; workspaceId: string }): string[] {
    return this.serverStore(input).urls;
  }

  appRunning(input: { projectId: string; workspaceId: string }): boolean {
    return this.serverStore(input).servers.length > 0;
  }

  private serverStore(input: { projectId: string; workspaceId: string }): PreviewServerStore {
    let store = this.servers.get(input.workspaceId);
    if (!store) {
      const project = asAvailableProject(getProjectStore(input.projectId));
      store = new PreviewServerStore({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        ...(project ? { hostAccess: project.host } : {}),
      });
      store.start();
      this.servers.set(input.workspaceId, store);
    }
    return store;
  }

  /** "Run app": starts the task's run script and opens the browser once its server is up. */
  async runApp(input: { projectId: string; workspaceId: string; taskId: string }): Promise<void> {
    const existing = this.devServerUrls(input)[0];
    if (existing) {
      this.openForTask({ ...input, url: existing });
      return;
    }
    const client = await getLifecycleScriptsClient();
    const result = await client.start({
      workspaceId: input.workspaceId,
      script: 'run',
      provenance: 'manual',
    });
    if (!result.success) {
      const message = 'message' in result.error ? result.error.message : String(result.error.type);
      toast.error('Could not run the app', {
        description: `${message}. Add a run script in the project's .emdash.json or settings.`,
      });
      return;
    }
    runInAction(() => this.starting.add(input.taskId));
    await this.refreshSettings();
    const store = this.serverStore(input);
    const dispose = reaction(
      () => store.urls[0],
      (url) => {
        if (!url) return;
        finish();
        if (this.settings.autoOpenOnRun) this.openForTask({ ...input, url });
      }
    );
    const finish = () => {
      dispose();
      clearTimeout(this.startTimers.get(input.taskId));
      this.startTimers.delete(input.taskId);
      runInAction(() => this.starting.delete(input.taskId));
    };
    this.startTimers.set(
      input.taskId,
      setTimeout(() => {
        finish();
        toast('The app has not opened a port yet', {
          description: 'Check the run script output in the task view.',
        });
      }, APP_START_TIMEOUT_MS)
    );
  }

  async stopApp(input: { projectId: string; workspaceId: string; taskId: string }): Promise<void> {
    const client = await getLifecycleScriptsClient();
    const result = await client.stop({ workspaceId: input.workspaceId, script: 'run' });
    if (!result.success) {
      // Not started by the run script (a terminal-started server): stop what was detected.
      const store = this.serverStore(input);
      await Promise.all(store.servers.map((server) => store.stop(server.id).catch(() => {})));
    }
    runInAction(() => this.starting.delete(input.taskId));
  }

  // ── Main-process events ────────────────────────────────────────────────────

  private async refreshSettings(): Promise<void> {
    const snapshot = getAppSettingValueSnapshot('canvasBrowser');
    if (snapshot) {
      this.settings = snapshot;
      return;
    }
    const meta = await fetchAppSettingsMeta('canvasBrowser').catch(() => undefined);
    if (meta) this.settings = meta.value;
  }

  private async subscribe(): Promise<void> {
    const client = await getBrowserClient();
    const unsubscribe = await client.events.subscribe(undefined, {
      onEvent: (event) => this.handleEvent(event),
      onGap: () => {},
    });
    if (this.disposed) unsubscribe();
    else this.unsubscribeEvents = unsubscribe;
  }

  private handleEvent(event: BrowserEvent): void {
    if (event.type === 'automation') {
      runInAction(() => {
        if (event.leaseUntil) {
          this.leases.set(event.browserId, { until: event.leaseUntil, actor: event.actor });
          this.scheduleLeaseExpiry(event.browserId, event.leaseUntil);
          if (!this.isAlive(event.browserId)) this.ensureAlive(event.browserId);
        } else if (event.action === 'lease') {
          this.leases.delete(event.browserId);
        }
        this.activity.set(
          event.browserId,
          `${actorName(event.actor)}: ${event.action}${event.ok ? '' : ' (failed)'}`
        );
      });
      return;
    }
    if (event.type === 'open-request') void this.handleOpenRequest(event);
  }

  private scheduleLeaseExpiry(browserId: string, until: number): void {
    clearTimeout(this.leaseTimers.get(browserId));
    this.leaseTimers.set(
      browserId,
      setTimeout(
        () => {
          this.leaseTimers.delete(browserId);
          const lease = this.leases.get(browserId);
          if (lease && lease.until <= Date.now()) runInAction(() => this.leases.delete(browserId));
        },
        Math.max(0, until - Date.now()) + 50
      )
    );
  }

  /**
   * An agent (via main) wants its task's browser. `observe` only resumes an existing tile so it
   * can be read. `control` opens or resumes the tile under agent control: a new tile starts that
   * way (the agent-control setting is the user's consent), while a tile the user set to "You" is
   * only handed over when they allow it.
   */
  private async handleOpenRequest(
    event: Extract<BrowserEvent, { type: 'open-request' }>
  ): Promise<void> {
    await this.refreshSettings();
    const client = await getBrowserClient();
    if (!this.settings.enabled) {
      await client.ackOpenRequest({
        requestId: event.requestId,
        browserId: null,
        denial: 'disabled',
      });
      return;
    }
    const existing = this.canvas.browserForTask(event.taskId);
    if (event.access === 'observe') {
      if (existing) {
        this.ensureSession(existing);
        this.ensureAlive(existing.browserId);
      }
      await client.ackOpenRequest({
        requestId: event.requestId,
        browserId: existing?.browserId ?? null,
      });
      return;
    }
    if (existing?.control === 'user') {
      const answer = await withTimeout(this.askToShare(existing, event.actor), CONSENT_ANSWER_MS);
      if (answer !== true) {
        await client.ackOpenRequest({
          requestId: event.requestId,
          browserId: null,
          denial: answer === false ? 'declined' : 'consent-pending',
        });
        return;
      }
    }
    const browserId = this.openForTask(
      {
        projectId: event.projectId,
        workspaceId: event.workspaceId,
        taskId: event.taskId,
        ...(event.url ? { url: event.url } : {}),
      },
      { control: 'agents', focus: false }
    );
    const entry = this.canvas.browserForTask(event.taskId);
    if (entry) await this.syncControl(entry);
    await client.ackOpenRequest({
      requestId: event.requestId,
      browserId: entry?.control === 'agents' ? browserId : null,
    });
  }

  /** Asks the user to let agents drive a tile they control. Resolves true once handed over. */
  private askToShare(entry: BrowserTileEntry, actor: BrowserAutomationActor): Promise<boolean> {
    const pending = this.consents.get(entry.taskId);
    if (pending) return pending;
    const prompt = new Promise<boolean>((resolve) => {
      toast(`${actorName(actor)} wants to use the app browser`, {
        id: `canvas-browser-consent-${entry.taskId}`,
        description:
          'Agents can already see it. Allow clicking and typing on this task\'s app? Switch back with "You" any time.',
        duration: CONSENT_TOAST_MS,
        action: {
          label: 'Let agents drive',
          onClick: () => {
            const current = this.canvas.browserForTask(entry.taskId);
            if (!current) return resolve(false);
            void this.applyControl(current, 'agents').then(resolve);
          },
        },
      });
    });
    const tracked = prompt.finally(() => this.consents.delete(entry.taskId));
    this.consents.set(entry.taskId, tracked);
    setTimeout(() => this.consents.delete(entry.taskId), CONSENT_TOAST_MS);
    return tracked;
  }
}

/** Resolves with the promise's value, or `null` if it has not settled in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function actorName(actor: BrowserAutomationActor): string {
  return actor.kind === 'conductor' ? 'Conductor' : (actor.name ?? 'Agent');
}

function sameRects(a: readonly TileRect[], b: readonly TileRect[]): boolean {
  return (
    a.length === b.length &&
    a.every((rect, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        rect.x === other.x &&
        rect.y === other.y &&
        rect.w === other.w &&
        rect.h === other.h
      );
    })
  );
}
