import type { Logger } from '@emdash/shared/logger';
import { peek } from '@emdash/wire/state';
import type { TuiAgentState } from '#runtimes/tui-agents/api';
import {
  produceCell,
  type TuiAgentStatesListModel,
  type TuiSessionsListModel,
} from '#runtimes/tui-agents/node/state/live-models';
import type {
  BackgroundWork,
  BackgroundWorkKind,
  CanonicalHookEvent,
  ResolvedTuiProvider,
} from '#services/agent-plugins/api/plugins';
import { defaultHookEventParser } from '#services/agent-plugins/api/plugins/helpers';
import { sameSubAgents, SubAgentSet } from './sub-agents';

const LATE_START_MS = 1_000;
/** Past this, Enter answered a menu and this start belongs to some later prompt. */
const LATE_START_UNRELATED_MS = 5 * 60_000;

/**
 * How long a change to the running sub-agents waits before it is published, so a burst (several
 * started in parallel) goes out as one update. A status change publishes the latest at once.
 */
export const SUB_AGENT_PUBLISH_DELAY_MS = 100;

/** Esc or Ctrl+C on its own: the agent's turn is cut short. */
const INTERRUPT_INPUT = /^(?:\x1b+|\x03+)$/;

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

type TrackedBackgroundWork = {
  /** Work the latest stop reported as still in flight. */
  inFlight: readonly BackgroundWork[];
  /**
   * Ids of long-lived work already in flight when the user last opened a turn; they no longer
   * hold completion. Agent work is never acknowledged: it reports back into the conversation.
   */
  acknowledged: ReadonlySet<string>;
};

/** Work a later user turn may stop waiting on; agent work holds until it reports back. */
function isAcknowledgeable(kind: BackgroundWorkKind): boolean {
  return kind !== 'agent';
}

export class TuiAgentStates {
  private readonly backgroundWork = new Map<string, TrackedBackgroundWork>();

  /** When Enter last went to each agent that will report the prompt through a hook. */
  private readonly submittedAt = new Map<string, number>();

  /** The sub-agents running inside each session, for agents whose hooks report them. */
  private readonly subAgents = new Map<string, SubAgentSet>();

  /** Sub-agent changes waiting to be published, per conversation. */
  private readonly subAgentPublishes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly sessions: TuiSessionsListModel,
    private readonly agentStates: TuiAgentStatesListModel,
    private readonly now: () => number,
    private readonly onProviderSessionIdChanged?: ProviderSessionIdChangedHandler,
    private readonly onAgentStateChanged?: AgentStateChangedHandler,
    private readonly logger?: Logger
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
    if (event.kind === 'subagent') {
      const set = this.subAgentSet(conversationId);
      const changed =
        event.type === 'start'
          ? set.started(event.subAgent, this.now())
          : set.stopped(event.subAgent.agentId, event.running);
      if (changed) this.scheduleSubAgentsPublish(conversationId);
      return;
    }

    if (event.providerSessionId) {
      this.setProviderSessionId(conversationId, event.providerSessionId);
    }

    if (event.type === 'start') {
      this.logLateStart(conversationId);
      this.openTurn(conversationId, providerId, event.initiator ?? 'user');
      this.setStatus(conversationId, {
        providerId,
        source: 'hook',
        status: 'working',
        // Subagents are never acknowledged, so the ones still out stay awaited through any turn.
        backgroundAgents: this.awaitedAgentCount(conversationId),
        title: event.title,
        message: event.message,
        lastAssistantMessage: event.lastAssistantMessage,
      });
      return;
    }

    if (event.type === 'stop') {
      // A turn that ends with background work it is waiting on is paused, not finished: the
      // provider wakes the session when that work settles and reports a further stop.
      const reported = event.backgroundWork ?? [];
      const awaited = this.recordBackgroundWork(conversationId, reported);
      if (this.subAgents.has(conversationId) || event.subAgents?.length) {
        this.subAgentSet(conversationId).turnEnded(event.subAgents ?? [], this.now());
      }
      const awaiting = awaited.length > 0;
      const status = awaiting ? 'working' : 'completed';
      // Warn on purpose: the app's file log drops info by default, and this line is a temporary
      // diagnostic for unexplained completions, to downgrade once they are understood. Ids and
      // kinds only: descriptions and command lines stay out of the shared log.
      this.logger?.warn('TuiAgentStates: stop applied', {
        conversationId,
        providerId,
        ...idsByKind(reported),
        awaited: awaited.map((work) => work.id),
        acknowledged: reported.filter((work) => !awaited.includes(work)).map((work) => work.id),
        status,
      });
      this.setStatus(conversationId, {
        providerId,
        source: 'hook',
        status,
        awaitingBackgroundWork: awaiting || undefined,
        backgroundAgents: countAgents(awaited),
        title: event.title,
        message: event.message,
        lastAssistantMessage: event.lastAssistantMessage,
      });
      return;
    }

    if (event.type === 'error') {
      // An API error ended the turn, and the sub-agents it ran in the foreground with it.
      this.subAgents.get(conversationId)?.interrupted();
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
    if (INTERRUPT_INPUT.test(data) && this.subAgents.get(conversationId)?.interrupted()) {
      this.scheduleSubAgentsPublish(conversationId);
    }
    if (!data.includes('\r')) return;
    if (provider?.hooks.kind !== 'none' && provider?.hooks.supportedEvents.includes('start')) {
      this.submittedAt.set(conversationId, this.now());
      return;
    }
    this.setStatus(conversationId, { status: 'working', source: 'input' });
  }

  /**
   * How long the agent took to report a prompt after Enter was written to it. Time spent here is
   * inside the agent and its hooks, not on Maestro's way to the terminal.
   */
  private logLateStart(conversationId: string): void {
    const submittedAt = this.submittedAt.get(conversationId);
    if (submittedAt === undefined) return;
    this.submittedAt.delete(conversationId);
    const elapsedMs = this.now() - submittedAt;
    if (elapsedMs >= LATE_START_MS && elapsedMs < LATE_START_UNRELATED_MS) {
      this.logger?.warn('TuiAgentStates: agent reported the submitted prompt late', {
        conversationId,
        elapsedMs,
      });
    }
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
    this.dropSubAgents(conversationId);
    this.setStatus(conversationId, { status: 'idle' });
  }

  clear(conversationId: string): void {
    this.backgroundWork.delete(conversationId);
    this.dropSubAgents(conversationId);
    produceCell(this.agentStates.states.list, (draft) => {
      delete draft[conversationId];
    });
  }

  current(conversationId: string): TuiAgentState | undefined {
    return peek(this.agentStates.states.list)[conversationId];
  }

  /** A state saved before a restart; the sub-agents it lists are not known to still run. */
  restore(state: TuiAgentState): void {
    const { subAgents: _stale, ...restored } = state;
    produceCell(this.agentStates.states.list, (draft) => {
      draft[state.conversationId] = restored;
    });
  }

  private subAgentSet(conversationId: string): SubAgentSet {
    let set = this.subAgents.get(conversationId);
    if (!set) {
      set = new SubAgentSet();
      this.subAgents.set(conversationId, set);
    }
    return set;
  }

  private subAgentList(conversationId: string): TuiAgentState['subAgents'] {
    const set = this.subAgents.get(conversationId);
    const list = set?.list();
    if (set && !list) this.subAgents.delete(conversationId);
    return list;
  }

  private dropSubAgents(conversationId: string): void {
    this.subAgents.delete(conversationId);
    this.cancelSubAgentsPublish(conversationId);
  }

  private scheduleSubAgentsPublish(conversationId: string): void {
    if (this.subAgentPublishes.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.subAgentPublishes.delete(conversationId);
      this.publishSubAgents(conversationId);
    }, SUB_AGENT_PUBLISH_DELAY_MS);
    timer.unref?.();
    this.subAgentPublishes.set(conversationId, timer);
  }

  private cancelSubAgentsPublish(conversationId: string): void {
    const timer = this.subAgentPublishes.get(conversationId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.subAgentPublishes.delete(conversationId);
  }

  /**
   * Publishes the running sub-agents alone: the agent's status, its message and `updatedAt` stay
   * as they were. Nothing is persisted for it: a restored state drops its sub-agents anyway.
   */
  private publishSubAgents(conversationId: string): void {
    const subAgents = this.subAgentList(conversationId);
    produceCell(this.agentStates.states.list, (draft) => {
      const previous = draft[conversationId];
      if (sameSubAgents(previous?.subAgents, subAgents)) return;
      if (!previous) {
        // A sub-agent runs, so the agent is working, though no prompt was reported yet.
        draft[conversationId] = {
          conversationId,
          status: 'working',
          source: 'hook',
          subAgents,
          updatedAt: this.now(),
        };
        return;
      }
      const { subAgents: _previous, ...rest } = previous;
      draft[conversationId] = subAgents ? { ...rest, subAgents } : rest;
    });
  }

  /**
   * A user-opened turn acknowledges the long-lived work already running: that work (a dev
   * server, a build the user asked about mid-flight) must not hold back this turn's completion.
   * Agent work stays awaited, and a background wake-up acknowledges nothing.
   */
  private openTurn(
    conversationId: string,
    providerId: string | undefined,
    initiator: 'user' | 'background'
  ): void {
    const work = this.backgroundWork.get(conversationId);
    if (!work) return;
    let { acknowledged } = work;
    if (initiator === 'user') {
      acknowledged = new Set(
        work.inFlight.filter((item) => isAcknowledgeable(item.kind)).map((item) => item.id)
      );
      this.backgroundWork.set(conversationId, { ...work, acknowledged });
    }
    // Warn on purpose, like the stop line: a temporary diagnostic the default file log keeps.
    this.logger?.warn('TuiAgentStates: turn opened with background work in flight', {
      conversationId,
      providerId,
      initiator,
      awaited: work.inFlight.filter((item) => !acknowledged.has(item.id)).map((item) => item.id),
      acknowledged: [...acknowledged],
    });
  }

  /** Records the in-flight work a stop reported; returns the part that is still awaited. */
  private recordBackgroundWork(
    conversationId: string,
    inFlight: readonly BackgroundWork[]
  ): BackgroundWork[] {
    const acknowledged = this.backgroundWork.get(conversationId)?.acknowledged ?? new Set<string>();
    if (inFlight.length === 0 && acknowledged.size === 0) {
      this.backgroundWork.delete(conversationId);
      return [];
    }
    this.backgroundWork.set(conversationId, { inFlight, acknowledged });
    return inFlight.filter((work) => !acknowledged.has(work.id));
  }

  /** How many in-flight subagents the conversation is waiting on; undefined for none. */
  private awaitedAgentCount(conversationId: string): number | undefined {
    const work = this.backgroundWork.get(conversationId);
    if (!work) return undefined;
    return countAgents(work.inFlight.filter((item) => !work.acknowledged.has(item.id)));
  }

  /**
   * The tracked ids outlive an interleaved permission prompt, which replaces the state; the
   * state's own flag covers a restored session, whose tracked ids did not survive the restart.
   */
  private awaitsBackgroundWork(conversationId: string): boolean {
    const work = this.backgroundWork.get(conversationId);
    if (!work) return this.current(conversationId)?.awaitingBackgroundWork === true;
    return work.inFlight.some((item) => !work.acknowledged.has(item.id));
  }

  private setStatus(
    conversationId: string,
    patch: Omit<Partial<TuiAgentState>, 'conversationId' | 'updatedAt'>
  ): void {
    // The state carries the latest sub-agents from here on: nothing is left to publish later.
    this.cancelSubAgentsPublish(conversationId);
    const subAgents = this.subAgentList(conversationId);
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
        backgroundAgents: patch.backgroundAgents,
        subAgents,
        updatedAt: this.now(),
      };
      if (!subAgents) delete next.subAgents;

      if (
        previous &&
        previous.providerId === next.providerId &&
        previous.status === next.status &&
        previous.source === next.source &&
        previous.notificationType === next.notificationType &&
        previous.title === next.title &&
        previous.message === next.message &&
        previous.lastAssistantMessage === next.lastAssistantMessage &&
        previous.awaitingBackgroundWork === next.awaitingBackgroundWork &&
        previous.backgroundAgents === next.backgroundAgents &&
        sameSubAgents(previous.subAgents, next.subAgents)
      ) {
        return;
      }

      draft[conversationId] = next;
      changedState = next;
    });
    if (changedState) this.onAgentStateChanged?.(conversationId, changedState);
  }
}

function idsByKind(work: readonly BackgroundWork[]): Record<string, string[]> {
  const ids = { agents: [] as string[], processes: [] as string[], wakeups: [] as string[] };
  for (const item of work) {
    if (item.kind === 'agent') ids.agents.push(item.id);
    else if (item.kind === 'wakeup') ids.wakeups.push(item.id);
    else ids.processes.push(item.id);
  }
  return ids;
}

function countAgents(work: readonly BackgroundWork[]): number | undefined {
  const count = work.filter((item) => item.kind === 'agent').length;
  return count > 0 ? count : undefined;
}
