import type {
  RemoteAgent,
  RemoteOverview,
  RemoteProject,
} from '@emdash/core/services/remote-control/api';
import { ReplicaState, type StateStore } from '@emdash/wire/live';
import { createImmutableMobxStore } from '@emdash/wire/mobx';
import { makeAutoObservable, reaction, runInAction } from 'mobx';
import {
  countNeedingAttention,
  filterAgents,
  groupAgents,
  type AgentGroup,
} from '../lib/agent-groups';
import {
  fetchSession,
  pairDevice,
  signOut,
  type PairFailure,
  type SessionInfo,
} from '../lib/session-api';
import {
  createWireLink,
  wireUrlFor,
  type LinkStatus,
  type RemoteApi,
  type WireLink,
} from '../lib/wire-link';

/**
 * - `loading`: asking the host who we are.
 * - `unreachable`: the host did not answer; retried in the background.
 * - `unpaired`: the host answered and does not know this browser.
 * - `paired`: signed in; the Wire link is up or coming up.
 */
export type AppPhase = 'loading' | 'unreachable' | 'unpaired' | 'paired';

export type Toast = { id: number; text: string; tone: 'info' | 'error' };

const SESSION_RETRY_MS = 3_000;
const HEARTBEAT_MS = 20_000;
const OVERVIEW_RETRY_MS = 1_500;
const TOAST_MS = 4_000;
const RECONNECTING_GRACE_MS = 700;

/** Session, connection and the live overview of the host: everything above a single agent. */
export class AppStore {
  phase: AppPhase = 'loading';
  session: SessionInfo | null = null;
  linkStatus: LinkStatus = 'connecting';
  /** The socket itself, without the grace that keeps `linkStatus` from flickering. */
  linkUp = false;
  /** When the socket last came up (Unix ms); 0 before the first time. */
  linkUpAt = 0;
  projectFilter: string | null = null;
  showArchived = false;
  toasts: Toast[] = [];
  /** Advances with the heartbeat so relative times re-render without per-row timers. */
  now = Date.now();

  private link: WireLink | null = null;
  private overviewStore: StateStore<RemoteOverview> | null = null;
  private overviewReplica: ReplicaState<RemoteOverview> | null = null;
  private overviewReady = false;
  private sessionRetry: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private nextToastId = 1;

  constructor() {
    makeAutoObservable<
      AppStore,
      'link' | 'overviewStore' | 'overviewReplica' | 'sessionRetry' | 'statusTimer' | 'nextToastId'
    >(this, {
      link: false,
      overviewStore: false,
      overviewReplica: false,
      sessionRetry: false,
      statusTimer: false,
      nextToastId: false,
    });
  }

  /** Starts the app and wires it to the page's lifecycle. Returns the teardown. */
  start(): () => void {
    void this.loadSession();

    const probe = (): void => {
      if (document.visibilityState !== 'visible') return;
      runInAction(() => {
        this.now = Date.now();
      });
      if (this.phase === 'unreachable') void this.loadSession();
      this.link?.probe();
    };
    const heartbeat = setInterval(probe, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', probe);
    window.addEventListener('online', probe);
    window.addEventListener('pageshow', probe);

    const disposeBadge = reaction(
      () => this.attentionCount,
      (count) => reflectAttention(count),
      { fireImmediately: true }
    );

    return () => {
      clearInterval(heartbeat);
      clearTimeout(this.sessionRetry);
      document.removeEventListener('visibilitychange', probe);
      window.removeEventListener('online', probe);
      window.removeEventListener('pageshow', probe);
      disposeBadge();
      this.stopLink();
    };
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  get overview(): RemoteOverview | null {
    if (!this.overviewReady || !this.overviewStore) return null;
    return this.overviewStore.current();
  }

  /** Null until the overview has loaded; UI that needs the host API waits for it. */
  get api(): RemoteApi | null {
    return this.overviewReady ? (this.link?.api ?? null) : null;
  }

  get hostName(): string {
    return this.overview?.host.name ?? this.session?.hostName ?? 'your computer';
  }

  get agents(): readonly RemoteAgent[] {
    return this.overview?.agents ?? [];
  }

  get projects(): readonly RemoteProject[] {
    return this.overview?.projects ?? [];
  }

  get visibleAgents(): RemoteAgent[] {
    return filterAgents(this.agents, {
      projectId: this.projectFilter,
      showArchived: this.showArchived,
    });
  }

  get groups(): AgentGroup[] {
    return groupAgents(this.visibleAgents);
  }

  get attentionCount(): number {
    return countNeedingAttention(this.agents);
  }

  get archivedCount(): number {
    return this.agents.filter((agent) => agent.archived).length;
  }

  /** Projects that have at least one agent in the list, for the filter chips. */
  get filterProjects(): RemoteProject[] {
    const used = new Set(
      this.agents.filter((agent) => this.showArchived || !agent.archived).map((a) => a.projectId)
    );
    return this.projects.filter((project) => used.has(project.id));
  }

  agentById(conversationId: string): RemoteAgent | undefined {
    return this.agents.find((agent) => agent.conversationId === conversationId);
  }

  projectName(projectId: string): string {
    return this.projects.find((project) => project.id === projectId)?.name ?? '';
  }

  providerName(providerId: string): string {
    return this.overview?.providers.find((provider) => provider.id === providerId)?.name ?? '';
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  setProjectFilter(projectId: string | null): void {
    this.projectFilter = projectId;
  }

  setShowArchived(show: boolean): void {
    this.showArchived = show;
  }

  toast(text: string, tone: Toast['tone'] = 'info'): void {
    const id = this.nextToastId++;
    this.toasts.push({ id, text, tone });
    setTimeout(() => this.dismissToast(id), TOAST_MS);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  async loadSession(): Promise<void> {
    clearTimeout(this.sessionRetry);
    try {
      const session = await fetchSession();
      runInAction(() => {
        this.session = session;
        if (session.authenticated) this.enterPaired();
        else this.enterUnpaired();
      });
    } catch {
      runInAction(() => {
        // Already paired and running: the Wire link reports and repairs its own outages.
        if (this.phase === 'paired') return;
        this.phase = 'unreachable';
        this.sessionRetry = setTimeout(() => void this.loadSession(), SESSION_RETRY_MS);
      });
    }
  }

  /** Redeems a pairing code. Resolves with the reason on failure, undefined on success. */
  async pair(code: string, deviceName: string): Promise<PairFailure | undefined> {
    const result = await pairDevice(code, deviceName);
    if (!result.ok) return result.reason;
    runInAction(() => {
      this.session = {
        authenticated: true,
        hostId: result.hostId,
        hostName: result.hostName,
        device: { id: result.deviceId, name: deviceName },
      };
      this.enterPaired();
    });
    return undefined;
  }

  async signOut(): Promise<void> {
    await signOut();
    runInAction(() => this.enterUnpaired());
  }

  private enterPaired(): void {
    this.phase = 'paired';
    if (this.link) return;
    this.linkStatus = 'connecting';
    this.link = createWireLink({
      url: wireUrlFor(window.location),
      isSessionValid: async () => {
        try {
          return (await fetchSession()).authenticated;
        } catch {
          return undefined;
        }
      },
      onStatus: (status) => this.reflectLinkStatus(status),
      onSessionEnded: () => runInAction(() => this.enterUnpaired()),
    });
    this.followOverview(this.link);
  }

  /**
   * A dropped socket is usually back within a few hundred milliseconds. Announcing that would
   * only be noise, so an outage is shown once it has lasted a moment.
   */
  private reflectLinkStatus(status: LinkStatus): void {
    clearTimeout(this.statusTimer);
    runInAction(() => {
      this.linkUp = status === 'online';
      if (status === 'online') this.linkUpAt = Date.now();
    });
    if (status !== 'reconnecting') {
      runInAction(() => {
        this.linkStatus = status;
      });
      return;
    }
    this.statusTimer = setTimeout(() => {
      runInAction(() => {
        if (this.link) this.linkStatus = 'reconnecting';
      });
    }, RECONNECTING_GRACE_MS);
  }

  private enterUnpaired(): void {
    this.stopLink();
    this.phase = 'unpaired';
    this.projectFilter = null;
    if (this.session) this.session = { ...this.session, authenticated: false, device: undefined };
  }

  private followOverview(link: WireLink): void {
    if (this.link !== link) return;
    const store = createImmutableMobxStore<RemoteOverview>();
    const replica = new ReplicaState<RemoteOverview>(
      link.api.remote.overview.state(undefined, 'snapshot'),
      { store }
    );
    this.overviewStore = store;
    this.overviewReplica = replica;
    replica.ready.then(
      () =>
        runInAction(() => {
          if (this.overviewReplica === replica) this.overviewReady = true;
        }),
      () => {
        // The first snapshot can time out while the host is unreachable; the link keeps
        // reconnecting underneath, so start a fresh replica once it has had a moment.
        void replica.dispose().catch(() => {});
        if (this.overviewReplica !== replica) return;
        setTimeout(() => this.followOverview(link), OVERVIEW_RETRY_MS);
      }
    );
  }

  private stopLink(): void {
    const replica = this.overviewReplica;
    this.overviewReplica = null;
    this.overviewStore = null;
    this.overviewReady = false;
    void replica?.dispose().catch(() => {});
    clearTimeout(this.statusTimer);
    this.link?.close();
    this.link = null;
    this.linkStatus = 'connecting';
    this.linkUp = false;
  }
}

/** Mirrors the number of waiting agents into the tab title and the installed app's badge. */
function reflectAttention(count: number): void {
  document.title = count > 0 ? `(${count}) Maestro` : 'Maestro';
  const badge = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    const pending = count > 0 ? badge.setAppBadge?.(count) : badge.clearAppBadge?.();
    void pending?.catch(() => {});
  } catch {
    // Badging is unavailable in this browser or context.
  }
}
