import type { SerializedHostRef } from '@emdash/core/primitives/host/api';
import type { SessionSummary } from '@emdash/core/runtimes/acp/api/client';
import type { TuiSessionList } from '@emdash/core/runtimes/tui-agents/api';
import type { Disposable } from '@emdash/shared/concurrency';
import { ReplicaLog } from '@emdash/wire/live';
import type { Terminal } from '@xterm/xterm';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
// TODO(conversations-extraction): Inject file-link handlers instead of importing task editor plumbing.
import { makeFileLinkHandlers } from '@core/features/editor/api/browser/open-file-in-file-editor';
import {
  classifyLiveRuntimeObservation,
  type LiveRuntimeObservation,
} from '@core/features/projects/api/browser/live-runtime-observation';
import type { ProjectHostAccess } from '@core/features/projects/api/browser/stores/project-context';
import type { FrontendPtyConnector } from '@core/features/terminals/api/browser/pty/pty';
import { PtySession } from '@core/features/terminals/api/browser/pty/pty-session';
import { createXtermLogSink } from '@core/features/terminals/api/browser/pty/xterm-log-sink';
import { type AgentStatus, type NotificationType } from '@core/primitives/agents/api';
import type { CompletionReport } from '@core/primitives/agents/api/completion-report';
import { Resource } from '@core/primitives/async-resource/browser/resource';
import {
  type Conversation,
  type ConversationEvent,
  type CreateConversationParams,
} from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';
import { makePtySessionId } from '@core/primitives/pty/api';
import { getConversationsClient } from './client';
import { acquireProjectSessionLists } from './project-session-lists';

/**
 * Supplies measured terminal dimensions for a conversation's PTY spawn.
 * Injected by the workbench composition (which owns the pane layout); may wait
 * briefly for the pane's first measurement. Resolves null when no measurement
 * is available in time, in which case the spawn falls back to the backend
 * default size.
 */
export type ConversationInitialSizeResolver = (
  conversationId?: string
) => Promise<{ cols: number; rows: number } | null>;

export class ConversationManagerStore implements Disposable {
  private _initialSizeResolver: ConversationInitialSizeResolver | null = null;
  private offConversationEvents: (() => void) | null = null;
  private offSessionLists: (() => void) | null = null;
  private lastTuiList: TuiSessionList = {};
  private lastAcpList: Record<string, SessionSummary> = {};
  private readonly _disposeHostReaction: () => void;
  private _hasObservedTuiSessions = false;
  private _hasObservedAcpSessions = false;
  private _disposed = false;
  private _membershipChangesDuringLoad: Set<string> | null = null;
  private readonly _pendingDeletions = new Map<string, { confirmed: boolean }>();

  /** Data layer: plain Conversation records loaded from the main process. */
  readonly list: Resource<Conversation[]>;
  /** Runtime state stores reconciled from successful loads and conversation events. */
  conversations = observable.map<string, ConversationStore>();
  /** Session layer keyed by conversation id — created alongside data, connected lazily. */
  sessions = observable.map<string, PtySession>();
  activeTuiSessionIds = observable.set<string>();
  activeAcpSessionIds = observable.set<string>();

  constructor(
    private readonly projectId: string,
    private readonly taskId: string,
    preloaded: Conversation[] | undefined,
    private readonly sessionHost: () => SerializedHostRef,
    readonly hostAccess?: ProjectHostAccess
  ) {
    makeObservable<ConversationManagerStore, '_hasObservedAcpSessions' | '_hasObservedTuiSessions'>(
      this,
      {
        conversations: observable,
        sessions: observable,
        activeTuiSessionIds: observable,
        activeAcpSessionIds: observable,
        _hasObservedTuiSessions: observable,
        _hasObservedAcpSessions: observable,
        activeSessionIds: computed,
        taskStatus: computed,
        runtimeObservation: computed,
      }
    );

    const hasPreloaded = preloaded !== undefined;
    this.list = new Resource<Conversation[]>(
      () => this.loadConversations(),
      hasPreloaded ? [] : [{ kind: 'demand' }],
      hasPreloaded ? { init: preloaded } : undefined
    );

    // When preloaded data is available, populate the maps synchronously so
    // they are accessible immediately, including inside an outer MobX action.
    if (preloaded) {
      runInAction(() => {
        for (const conversation of preloaded) {
          this.addConversation(conversation);
        }
      });
    }
    this._disposeHostReaction = reaction(
      () => this.hostAccess?.state,
      (state) => {
        if (state?.kind !== 'ready') return;
        for (const session of this.sessions.values()) session.resumeIfRequested();
      }
    );

    this.offConversationEvents = this.listenToConversationEvents();
    this.offSessionLists = this.listenToProjectSessionLists();
    if (!hasPreloaded) void this.list.load();
  }

  private addConversation(conversation: Conversation): void {
    if (this._disposed || this._pendingDeletions.has(conversation.id)) return;
    this._membershipChangesDuringLoad?.add(conversation.id);
    if (!this.conversations.has(conversation.id)) {
      this.conversations.set(conversation.id, new ConversationStore(conversation));
    }
    if (!this.sessions.has(conversation.id)) {
      this.sessions.set(conversation.id, this.createSession(conversation));
    }
    this.syncActiveSessionMembership(conversation.id);
  }

  private removeConversation(conversationId: string, dispose = true): void {
    this._membershipChangesDuringLoad?.add(conversationId);
    const conversation = this.conversations.get(conversationId);
    const session = this.sessions.get(conversationId);
    this.conversations.delete(conversationId);
    this.sessions.delete(conversationId);
    this.activeTuiSessionIds.delete(conversationId);
    this.activeAcpSessionIds.delete(conversationId);
    if (dispose) {
      conversation?.dispose();
      session?.destroy();
    }
  }

  private async loadConversations(): Promise<Conversation[]> {
    const changed = new Set<string>();
    this._membershipChangesDuringLoad = changed;
    try {
      const data = await (
        await getConversationsClient()
      ).getConversationsForTask({
        projectId: this.projectId,
        taskId: this.taskId,
      });
      if (this._disposed) return data;
      runInAction(() => {
        const present = new Set(data.map((conversation) => conversation.id));
        for (const id of this.conversations.keys()) {
          if (!present.has(id) && !changed.has(id)) this.removeConversation(id);
        }
        for (const conversation of data) {
          if (!changed.has(conversation.id)) this.addConversation(conversation);
        }
      });
      return data;
    } finally {
      this._membershipChangesDuringLoad = null;
    }
  }

  private subscribeConversationEvents(onEvent: (event: ConversationEvent) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getConversationsClient().then(async (client) => {
      const nextUnsubscribe = await client.events.subscribe(
        { taskId: this.taskId },
        {
          onEvent: (event) => {
            if (!disposed) onEvent(event);
          },
          onGap: () => {
            if (!disposed) this.list.invalidate();
          },
        }
      );
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }

  private listenToConversationEvents(): () => void {
    return this.subscribeConversationEvents((event) => this.applyConversationEvent(event));
  }

  private applyConversationEvent(event: ConversationEvent): void {
    switch (event.type) {
      case 'agent-status-changed':
        this.applyAgentStatusChanged(event);
        return;
      case 'created':
        this.applyConversationCreated(event);
        return;
      case 'changed':
        this.applyConversationChanged(event);
        return;
      case 'deleted':
        this.applyConversationDeleted(event);
        return;
    }
  }

  private listenToProjectSessionLists(): () => void {
    return acquireProjectSessionLists(
      this.projectId,
      this.sessionHost,
      this.hostAccess,
      (lists) => {
        if (lists.hasObservedTui) this.handleTuiSessionListChanged(lists.tui);
        if (lists.hasObservedAcp) this.handleAcpSessionListChanged(lists.acp);
      }
    );
  }

  private handleTuiSessionListChanged(list: TuiSessionList): void {
    runInAction(() => {
      this._hasObservedTuiSessions = true;
      this.lastTuiList = list;
      const active = new Set<string>();
      for (const [conversationId, session] of Object.entries(list)) {
        if (!this.conversations.has(conversationId)) continue;
        if (session.status === 'starting' || session.status === 'running') {
          active.add(conversationId);
        }
      }
      reconcileSet(this.activeTuiSessionIds, active);
    });
  }

  private handleAcpSessionListChanged(list: Record<string, SessionSummary>): void {
    runInAction(() => {
      this._hasObservedAcpSessions = true;
      this.lastAcpList = list;
      const active = new Set<string>();
      for (const [conversationId, session] of Object.entries(list)) {
        if (!this.conversations.has(conversationId)) continue;
        if (session.lifecycle !== 'closed') {
          active.add(conversationId);
        }
      }
      reconcileSet(this.activeAcpSessionIds, active);
    });
  }

  private syncActiveSessionMembership(conversationId: string): void {
    const tui = this.lastTuiList[conversationId];
    if (tui && (tui.status === 'starting' || tui.status === 'running')) {
      this.activeTuiSessionIds.add(conversationId);
    }
    const acp = this.lastAcpList[conversationId];
    if (acp && acp.lifecycle !== 'closed') {
      this.activeAcpSessionIds.add(conversationId);
    }
  }

  private applyAgentStatusChanged(
    payload: Extract<ConversationEvent, { type: 'agent-status-changed' }>
  ): void {
    if (payload.taskId !== this.taskId) return;
    const conversationStore = this.conversations.get(payload.conversationId);
    if (!conversationStore) return;

    runInAction(() => {
      conversationStore.status = payload.status;
      conversationStore.seen = payload.seen;
      if (payload.status !== 'awaiting-input') {
        conversationStore.lastNotificationType = null;
      }
      conversationStore.completionSummary =
        payload.status === 'completed' ? (payload.completionSummary ?? null) : null;
      conversationStore.completionReport =
        payload.status === 'completed' ? (payload.completionReport ?? null) : null;
    });
  }

  private applyConversationCreated(event: Extract<ConversationEvent, { type: 'created' }>): void {
    const { conversation } = event;
    if (conversation.taskId !== this.taskId || conversation.projectId !== this.projectId) return;
    runInAction(() => {
      this.addConversation(conversation);
    });
  }

  private applyConversationChanged(event: Extract<ConversationEvent, { type: 'changed' }>): void {
    if (event.taskId !== this.taskId) return;
    const store = this.conversations.get(event.conversationId);
    if (!store) return;
    runInAction(() => {
      Object.assign(store.data, event.changes);
    });
  }

  private applyConversationDeleted(event: Extract<ConversationEvent, { type: 'deleted' }>): void {
    if (event.taskId !== this.taskId || event.projectId !== this.projectId) return;
    const pending = this._pendingDeletions.get(event.conversationId);
    if (pending) pending.confirmed = true;
    runInAction(() => this.removeConversation(event.conversationId));
  }

  get taskStatus(): AgentStatus | null {
    let hasWorking = false;
    let hasUnseenError = false;
    let hasUnseenCompleted = false;
    for (const conversation of this.conversations.values()) {
      if (!conversation.seen && conversation.status === 'awaiting-input') return 'awaiting-input';
      if (conversation.status === 'working') hasWorking = true;
      if (!conversation.seen && conversation.status === 'error') hasUnseenError = true;
      if (!conversation.seen && conversation.status === 'completed') hasUnseenCompleted = true;
    }
    if (hasWorking) return 'working';
    if (hasUnseenError) return 'error';
    if (hasUnseenCompleted) return 'completed';
    return null;
  }

  get activeSessionIds(): Set<string> {
    return new Set([...this.activeTuiSessionIds, ...this.activeAcpSessionIds]);
  }

  get runtimeObservation(): LiveRuntimeObservation<{
    activeTuiSessionIds: string[];
    activeAcpSessionIds: string[];
  }> {
    const observed =
      this._hasObservedTuiSessions || this._hasObservedAcpSessions
        ? {
            activeTuiSessionIds: [...this.activeTuiSessionIds],
            activeAcpSessionIds: [...this.activeAcpSessionIds],
          }
        : undefined;
    return classifyLiveRuntimeObservation(
      this.hostAccess?.state ?? { kind: 'ready', hostGeneration: 0 },
      observed
    );
  }

  isSessionActive(conversationId: string): boolean {
    return (
      this.activeTuiSessionIds.has(conversationId) || this.activeAcpSessionIds.has(conversationId)
    );
  }

  /**
   * Injected by the owning composition so PTY spawns can start at the pane's
   * measured size instead of the backend default. Pass null to detach.
   */
  setInitialSizeResolver(resolver: ConversationInitialSizeResolver | null): void {
    this._initialSizeResolver = resolver;
  }

  private async resolveInitialSize(
    conversationId?: string
  ): Promise<{ cols: number; rows: number } | undefined> {
    const resolver = this._initialSizeResolver;
    if (!resolver) return undefined;
    try {
      return (await resolver(conversationId)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async createConversation(params: CreateConversationParams): Promise<Conversation> {
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      throw new Error('Live actions are unavailable for this Project.');
    }
    // ACP conversations start lazily and have no PTY, so skip the size wait.
    const initialSize =
      params.type === 'acp'
        ? params.initialSize
        : (params.initialSize ?? (await this.resolveInitialSize()));
    const result = await (
      await getConversationsClient()
    ).createConversation({ ...params, initialSize });
    if (!result.success) throw new Error(result.error.type);
    const conversation = result.data;
    runInAction(() => {
      this.addConversation(conversation);
    });
    return conversation;
  }

  async hydrateConversation(conversationId: string): Promise<void> {
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      throw new Error('Live actions are unavailable for this Project.');
    }
    // Hydrate is a no-op spawn-wise for ACP conversations; only PTY-backed
    // conversations benefit from waiting on a pane measurement.
    const isPty = this.conversations.get(conversationId)?.data.type !== 'acp';
    const initialSize = isPty ? await this.resolveInitialSize(conversationId) : undefined;
    const result = await (
      await getConversationsClient()
    ).hydrateConversation({
      projectId: this.projectId,
      taskId: this.taskId,
      conversationId,
      initialSize,
    });
    if (!result.success) throw new Error(result.error.type);
  }

  async dehydrateConversation(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    session?.dispose();
    if (this.hostAccess?.liveAction.kind === 'disabled') return;
    const result = await (
      await getConversationsClient()
    ).dehydrateConversation({
      projectId: this.projectId,
      taskId: this.taskId,
      conversationId,
    });
    if (!result.success) throw new Error(conversationErrorMessage(result.error));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const store = this.conversations.get(conversationId);
    const session = this.sessions.get(conversationId);
    if (!store) return;
    const pending = { confirmed: false };
    this._pendingDeletions.set(conversationId, pending);
    // Retain the original stores until the command settles so failure can roll back.
    runInAction(() => this.removeConversation(conversationId, false));
    let restored = false;

    try {
      await (
        await getConversationsClient()
      ).deleteConversation({
        projectId: this.projectId,
        taskId: this.taskId,
        conversationId,
      });
    } catch (err) {
      if (!pending.confirmed && !this._disposed) {
        runInAction(() => {
          this.conversations.set(conversationId, store);
          if (session) this.sessions.set(conversationId, session);
        });
        restored = true;
      }
      throw err;
    } finally {
      this._pendingDeletions.delete(conversationId);
      this._membershipChangesDuringLoad?.add(conversationId);
      if (!restored) {
        store.dispose();
        session?.destroy();
      }
    }
  }

  async killSession(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      throw new Error('Live actions are unavailable for this Project.');
    }
    const client = await getConversationsClient();
    const result =
      conversation.data.type === 'acp'
        ? await client.acp.terminate({ conversationId })
        : await client.tui.kill({ conversationId });
    if (!result.success) {
      throw new Error(
        conversationErrorMessage(result.error, `Failed to kill session '${conversationId}'`)
      );
    }
    runInAction(() => {
      this.activeAcpSessionIds.delete(conversationId);
      this.activeTuiSessionIds.delete(conversationId);
    });
  }

  async renameConversation(conversationId: string, name: string): Promise<void> {
    const store = this.conversations.get(conversationId);
    if (!store) return;

    const previousTitle = store.data.title;

    runInAction(() => {
      store.data.title = name;
    });

    try {
      await (
        await getConversationsClient()
      ).renameConversation({
        conversationId,
        name,
      });
    } catch (err) {
      runInAction(() => {
        store.data.title = previousTitle;
      });
      throw err;
    }
  }

  dispose(): void {
    this._disposed = true;
    this.list.dispose();
    this._disposeHostReaction();
    this.offConversationEvents?.();
    this.offConversationEvents = null;
    this.offSessionLists?.();
    this.offSessionLists = null;
    for (const session of this.sessions.values()) {
      session.destroy();
    }
  }

  private createSession(conversation: Conversation): PtySession {
    const handlers = makeFileLinkHandlers(conversation.projectId, conversation.taskId, {
      target: 'right',
    });
    const connector =
      conversation.type === 'acp'
        ? createNoopConnector()
        : createTuiAgentsConnector(conversation.id, () => {
            const state = this.hostAccess?.state;
            return !state ? 0 : state.kind === 'ready' ? state.hostGeneration : undefined;
          });
    return new PtySession(
      makePtySessionId(conversation.projectId, conversation.taskId, conversation.id),
      undefined,
      handlers.onOpenFile,
      handlers.onOpenExternal,
      connector,
      () => this.hostAccess?.liveAction.kind !== 'disabled'
    );
  }
}

function conversationErrorMessage(
  error: { type: string; message?: string },
  fallback = `Conversation operation failed: ${error.type}`
): string {
  return error.message ?? fallback;
}

function createNoopConnector(): FrontendPtyConnector {
  return {
    connect() {
      return () => {};
    },
  };
}

function createTuiAgentsConnector(
  conversationId: string,
  generation: () => number | undefined
): FrontendPtyConnector {
  let logBinding: ReplicaLog | null = null;
  let clientPromise: ReturnType<typeof getConversationsClient> | null = null;
  const client = () => {
    clientPromise ??= getConversationsClient();
    return clientPromise;
  };
  return {
    async connect(terminal: Terminal) {
      const runtime = await client();
      logBinding = new ReplicaLog(runtime.tui.output.handle({ conversationId }), {
        store: createXtermLogSink(terminal),
      });
      await logBinding.ready;
      return () => {
        void logBinding?.dispose();
        logBinding = null;
      };
    },
    async mirror(terminal: Terminal) {
      const runtime = await client();
      // Its own replica of the output log: the retained snapshot replays, then it follows live.
      const binding = new ReplicaLog(runtime.tui.output.handle({ conversationId }), {
        store: createXtermLogSink(terminal),
      });
      await binding.ready;
      return () => {
        void binding.dispose();
      };
    },
    sendInput(data: string) {
      const sentGeneration = generation();
      if (sentGeneration === undefined) return;
      void client()
        .then(async (runtime) => {
          if (generation() !== sentGeneration) return;
          const result = await runtime.tui.sendInput({ conversationId, data });
          if (!result.success) {
            log.warn('ConversationManagerStore: TUI input failed', {
              conversationId,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          log.warn('ConversationManagerStore: failed to send TUI input', {
            conversationId,
            error,
          });
        });
    },
    resize(cols: number, rows: number) {
      void client().then((runtime) => runtime.tui.resize({ conversationId, cols, rows }));
    },
  };
}

export class ConversationStore {
  data: Conversation;
  status: AgentStatus;
  seen: boolean;
  lastNotificationType: NotificationType | null = null;
  /** What the agent last finished, in a few words; set only while status is 'completed'. */
  completionSummary: string | null = null;
  /** The agent's final reply, redacted and bounded; set only while status is 'completed'. */
  completionReport: CompletionReport | null = null;

  constructor(conversation: Conversation) {
    this.data = conversation;
    this.status = conversation.agentStatus ?? 'idle';
    this.seen = conversation.agentStatusSeen ?? true;
    makeObservable(this, {
      data: observable,
      status: observable,
      seen: observable,
      lastNotificationType: observable,
      completionSummary: observable,
      completionReport: observable.ref,
      setStatus: action,
      setAwaitingInput: action,
      setWorking: action,
      clearWorking: action,
      markSeen: action,
      isInitialConversation: computed,
      indicatorStatus: computed,
    });
  }

  get isInitialConversation(): boolean {
    return this.data.isInitialConversation === true;
  }

  get indicatorStatus(): AgentStatus | null {
    if (this.status === 'working') return 'working';
    if (this.seen) return null;
    if (this.status === 'awaiting-input') return 'awaiting-input';
    if (this.status === 'error') return 'error';
    if (this.status === 'completed') return 'completed';
    return null;
  }

  setStatus(status: AgentStatus) {
    this.status = status;
    this.seen = status === 'idle' || status === 'working';
    if (status !== 'awaiting-input') {
      this.lastNotificationType = null;
    }
    if (status !== 'completed') {
      this.completionSummary = null;
      this.completionReport = null;
    }
  }

  setAwaitingInput(notificationType: NotificationType) {
    this.lastNotificationType = notificationType;
    this.setStatus('awaiting-input');
  }

  setWorking() {
    if (this.status === 'awaiting-input' && this.lastNotificationType === 'permission_prompt') {
      return;
    }
    this.lastNotificationType = null;
    this.setStatus('working');
  }

  clearWorking() {
    if (this.status === 'working' || this.status === 'awaiting-input') {
      this.setStatus('idle');
    }
  }

  markSeen() {
    this.seen = true;
    void getConversationsClient().then((client) =>
      client.markConversationSeen({ conversationId: this.data.id })
    );
  }

  dispose() {
    // Session is managed by ConversationManagerStore.sessions — nothing to do here.
  }
}

/**
 * Brings an observable set to `next` without touching unchanged members. Session lists republish on
 * every activity tick (e.g. each keystroke's `lastInputAt`); clearing and refilling would notify
 * every observer — canvas tiles, panels, terminals — even though membership rarely changes.
 */
function reconcileSet(target: Set<string>, next: ReadonlySet<string>): void {
  for (const id of [...target]) {
    if (!next.has(id)) target.delete(id);
  }
  for (const id of next) target.add(id);
}
