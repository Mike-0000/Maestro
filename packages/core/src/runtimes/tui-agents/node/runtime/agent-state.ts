import { peek } from '@emdash/wire/state';
import type { TuiAgentState } from '#runtimes/tui-agents/api';
import {
  produceCell,
  type TuiAgentStatesListModel,
  type TuiSessionsListModel,
} from '#runtimes/tui-agents/node/state/live-models';
import type { ResolvedTuiProvider } from '#services/agent-plugins/api/plugins';
import type { CanonicalHookEvent } from '#services/agent-plugins/api/plugins';
import { defaultHookEventParser } from '#services/agent-plugins/api/plugins/helpers';

const ATTENTION_NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
]);

export type ProviderSessionIdChangedHandler = (
  conversationId: string,
  providerSessionId: string
) => void;

export type AgentStateChangedHandler = (conversationId: string, state: TuiAgentState) => void;

type BackgroundWork = {
  /** Ids the latest stop reported as still in flight. */
  inFlight: ReadonlySet<string>;
  /** Ids already in flight when the user last opened a turn; they no longer hold completion. */
  acknowledged: ReadonlySet<string>;
};

export class TuiAgentStates {
  private readonly backgroundWork = new Map<string, BackgroundWork>();

  constructor(
    private readonly sessions: TuiSessionsListModel,
    private readonly agentStates: TuiAgentStatesListModel,
    private readonly now: () => number,
    private readonly onProviderSessionIdChanged?: ProviderSessionIdChangedHandler,
    private readonly onAgentStateChanged?: AgentStateChangedHandler
  ) {}

  applyRawHookEvent(
    conversationId: string,
    provider: Pick<ResolvedTuiProvider, 'parseHookEvent'> | null,
    eventType: string,
    body: Record<string, unknown>
  ): void {
    const event =
      provider?.parseHookEvent?.(eventType, body) ?? defaultHookEventParser(eventType, body);
    this.applyCanonicalEvent(conversationId, undefined, event);
  }

  applyCanonicalEvent(
    conversationId: string,
    providerId: string | undefined,
    event: CanonicalHookEvent
  ): void {
    if (event.kind === 'ignore') return;
    if (event.kind === 'session') {
      this.setProviderSessionId(conversationId, event.providerSessionId);
      return;
    }

    if (event.providerSessionId) {
      this.setProviderSessionId(conversationId, event.providerSessionId);
    }

    if (event.type === 'start') {
      if (event.initiator !== 'background') this.acknowledgeBackgroundWork(conversationId);
      this.setStatus(conversationId, {
        providerId,
        source: 'hook',
        status: 'working',
        title: event.title,
        message: event.message,
        lastAssistantMessage: event.lastAssistantMessage,
      });
      return;
    }

    if (event.type === 'stop') {
      // A turn that ends with background work it is waiting on is paused, not finished: the
      // provider wakes the session when that work settles and reports a further stop.
      const awaiting = this.recordBackgroundWork(conversationId, event.backgroundWork ?? []);
      this.setStatus(conversationId, {
        providerId,
        source: 'hook',
        status: awaiting ? 'working' : 'completed',
        awaitingBackgroundWork: awaiting || undefined,
        title: event.title,
        message: event.message,
        lastAssistantMessage: event.lastAssistantMessage,
      });
      return;
    }

    if (event.type === 'error') {
      this.setStatus(conversationId, {
        providerId,
        source: 'hook',
        status: 'error',
        title: event.title,
        message: event.message,
        lastAssistantMessage: event.lastAssistantMessage,
      });
      return;
    }

    // The provider's idle reminder fires while it waits on background work too; the user has
    // nothing to answer yet. Permission and elicitation prompts still surface.
    if (event.notificationType === 'idle_prompt' && this.awaitsBackgroundWork(conversationId)) {
      return;
    }

    const status =
      event.notificationType && ATTENTION_NOTIFICATION_TYPES.has(event.notificationType)
        ? 'awaiting-input'
        : 'idle';
    this.setStatus(conversationId, {
      providerId,
      source: 'hook',
      status,
      notificationType: event.notificationType,
      title: event.title,
      message: event.message,
      lastAssistantMessage: event.lastAssistantMessage,
    });
  }

  markInputSubmitted(
    conversationId: string,
    provider: Pick<ResolvedTuiProvider, 'hooks'> | null,
    data: string
  ): void {
    if (!data.includes('\r')) return;
    if (provider?.hooks.kind !== 'none' && provider?.hooks.supportedEvents.includes('start'))
      return;
    this.setStatus(conversationId, { status: 'working', source: 'input' });
  }

  markInitialPromptSubmitted(
    conversationId: string,
    providerId: string,
    provider: Pick<ResolvedTuiProvider, 'hooks'> | null,
    initialPrompt: string | undefined
  ): void {
    if (!initialPrompt?.trim()) return;
    if (provider?.hooks.kind !== 'none' && provider?.hooks.supportedEvents.includes('start'))
      return;
    this.setStatus(conversationId, { providerId, status: 'working', source: 'input' });
  }

  setProviderSessionId(conversationId: string, providerSessionId: string): void {
    let changed = false;
    produceCell(this.sessions.states.list, (draft) => {
      const session = draft[conversationId];
      if (!session || session.sessionId === providerSessionId) return;
      session.sessionId = providerSessionId;
      changed = true;
    });
    if (changed) this.onProviderSessionIdChanged?.(conversationId, providerSessionId);
  }

  resetToIdle(conversationId: string): void {
    this.backgroundWork.delete(conversationId);
    this.setStatus(conversationId, { status: 'idle' });
  }

  clear(conversationId: string): void {
    this.backgroundWork.delete(conversationId);
    produceCell(this.agentStates.states.list, (draft) => {
      delete draft[conversationId];
    });
  }

  current(conversationId: string): TuiAgentState | undefined {
    return peek(this.agentStates.states.list)[conversationId];
  }

  restore(state: TuiAgentState): void {
    produceCell(this.agentStates.states.list, (draft) => {
      draft[state.conversationId] = state;
    });
  }

  /**
   * A user-opened turn acknowledges whatever was already running: that work (a dev server, a
   * build the user asked about mid-flight) must not hold back this turn's completion.
   */
  private acknowledgeBackgroundWork(conversationId: string): void {
    const work = this.backgroundWork.get(conversationId);
    if (work) this.backgroundWork.set(conversationId, { ...work, acknowledged: work.inFlight });
  }

  /** Records the in-flight ids a stop reported; true when any of them is still awaited. */
  private recordBackgroundWork(conversationId: string, ids: readonly string[]): boolean {
    const acknowledged = this.backgroundWork.get(conversationId)?.acknowledged ?? new Set<string>();
    if (ids.length === 0 && acknowledged.size === 0) {
      this.backgroundWork.delete(conversationId);
      return false;
    }
    this.backgroundWork.set(conversationId, { inFlight: new Set(ids), acknowledged });
    return ids.some((id) => !acknowledged.has(id));
  }

  /**
   * The tracked ids outlive an interleaved permission prompt, which replaces the state; the
   * state's own flag covers a restored session, whose tracked ids did not survive the restart.
   */
  private awaitsBackgroundWork(conversationId: string): boolean {
    const work = this.backgroundWork.get(conversationId);
    if (!work) return this.current(conversationId)?.awaitingBackgroundWork === true;
    return [...work.inFlight].some((id) => !work.acknowledged.has(id));
  }

  private setStatus(
    conversationId: string,
    patch: Omit<Partial<TuiAgentState>, 'conversationId' | 'updatedAt'>
  ): void {
    let changedState: TuiAgentState | undefined;
    produceCell(this.agentStates.states.list, (draft) => {
      const previous = draft[conversationId];
      const next: TuiAgentState = {
        conversationId,
        providerId: patch.providerId ?? previous?.providerId,
        status: patch.status ?? previous?.status ?? 'idle',
        source: patch.source ?? previous?.source,
        notificationType: patch.notificationType,
        title: patch.title,
        message: patch.message,
        lastAssistantMessage: patch.lastAssistantMessage,
        awaitingBackgroundWork: patch.awaitingBackgroundWork,
        updatedAt: this.now(),
      };

      if (
        previous &&
        previous.providerId === next.providerId &&
        previous.status === next.status &&
        previous.source === next.source &&
        previous.notificationType === next.notificationType &&
        previous.title === next.title &&
        previous.message === next.message &&
        previous.lastAssistantMessage === next.lastAssistantMessage &&
        previous.awaitingBackgroundWork === next.awaitingBackgroundWork
      ) {
        return;
      }

      draft[conversationId] = next;
      changedState = next;
    });
    if (changedState) this.onAgentStateChanged?.(conversationId, changedState);
  }
}
