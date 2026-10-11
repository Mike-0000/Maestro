import { isAttentionNotification } from '@emdash/core/runtimes/tui-agents/api';
import { and, eq, inArray } from 'drizzle-orm';
import {
  type AgentEvent,
  type AgentStatus,
  type AgentStatusSignal,
} from '@core/primitives/agents/api';
import {
  getAttentionJudge,
  type AttentionJudge,
} from '@core/primitives/agents/api/attention-judge';
import { buildCompletionReport } from '@core/primitives/agents/api/completion-report';
import { summarizeCompletionMessage } from '@core/primitives/agents/api/completion-summary';
import type { ConversationEvent } from '@core/primitives/conversations/api';
import { HookCore, type Hookable } from '@core/primitives/hooks/api/hookable';
import { conversations } from '@core/services/app-db/node/schema';
import { getAppDb } from '@main/db/instance';
import { log } from '@main/lib/logger';

export type AgentStatusServiceHooks = {
  'agent:event': (event: AgentEvent) => void | Promise<void>;
};

export type ApplyAgentStatusSignalOptions = {
  deliver?: boolean;
  preserveSeen?: boolean;
  /** Fetches the turn's final reply when a stop carries none (chat agents keep it in a transcript). */
  loadReply?: () => Promise<string | null>;
};

/** The conductor's decision about a conversation's latest finished turn. */
type TurnVerdict = {
  /** Identifies the reply that was judged, so the same reply is never judged twice. */
  replyKey: string;
  needsDeveloper: boolean;
  /** False once the agent moved on: the verdict no longer describes where it stands. */
  current: boolean;
};

/** A verdict holds the status at 'working' while it runs; past this the stop is just a stop. */
const VERDICT_TIMEOUT_MS = 10_000;

function replyKey(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  }
  return `${text.length}:${hash >>> 0}`;
}

type ConversationContext = {
  projectId: string;
  taskId: string;
  providerId: string | null;
};

let publishConversationEvent: (event: ConversationEvent) => void = () => {};

export function setAgentStatusConversationEventPublisher(
  publisher: (event: ConversationEvent) => void
): void {
  publishConversationEvent = publisher;
}

function conversationContextSelection() {
  return {
    projectId: conversations.projectId,
    taskId: conversations.taskId,
    providerId: conversations.provider,
  };
}

function deriveAgentStatus(event: AgentStatusSignal): AgentStatus | null {
  if (event.type === 'start') return 'working';
  if (event.type === 'stop') return 'completed';
  if (event.type === 'error') return 'error';
  if (event.type === 'notification') {
    const nt = event.payload.notificationType;
    if (!nt) return null;
    if (isAttentionNotification(nt)) return 'awaiting-input';
  }
  return null;
}

export class AgentStatusService implements Hookable<AgentStatusServiceHooks> {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly verdicts = new Map<string, TurnVerdict>();
  /** Counts each conversation's live signals, so a held turn end can tell it was overtaken. */
  private readonly sequence = new Map<string, number>();
  private readonly hooks = new HookCore<AgentStatusServiceHooks>((name, error) =>
    log.error(`AgentStatusService: ${String(name)} hook error`, error)
  );

  on<K extends keyof AgentStatusServiceHooks>(name: K, handler: AgentStatusServiceHooks[K]) {
    return this.hooks.on(name, handler);
  }

  applySignal(
    signal: AgentStatusSignal,
    options: ApplyAgentStatusSignalOptions = {}
  ): Promise<void> {
    const id = signal.conversationId;
    const idleReminder =
      signal.type === 'notification' && signal.payload.notificationType === 'idle_prompt';
    let turn: number | undefined;
    if ((options.deliver ?? true) && !idleReminder) {
      turn = (this.sequence.get(id) ?? 0) + 1;
      this.sequence.set(id, turn);
    }
    return this.enqueue(id, () => this.applySignalQueued(signal, options, turn));
  }

  cacheSignal(signal: AgentStatusSignal): Promise<void> {
    return this.applySignal(signal, { deliver: false, preserveSeen: true });
  }

  resetToIdle(params: { conversationId: string }): Promise<void> {
    return this.enqueue(params.conversationId, () => this.resetToIdleQueued(params.conversationId));
  }

  private async applySignalQueued(
    signal: AgentStatusSignal,
    options: ApplyAgentStatusSignalOptions,
    turn?: number
  ): Promise<void> {
    const deliver = options.deliver ?? true;
    const turnEnded = signal.type === 'stop';
    const idleReminder =
      signal.type === 'notification' && signal.payload.notificationType === 'idle_prompt';
    if (turnEnded || idleReminder) {
      const judge = getAttentionJudge();
      if (!deliver) {
        // A restored snapshot (a host that reattached) repeats where the agent stands. The
        // provider's own state cannot hold the verdict, so a snapshot of the turn that was
        // judged must not undo it; a snapshot of a later turn replaces it.
        const verdict = this.verdicts.get(signal.conversationId);
        const snapshotKey = replyKeyOf(signal.payload.lastAssistantMessage);
        if (verdict?.current && snapshotKey !== null && snapshotKey !== verdict.replyKey) {
          this.retireVerdict(signal.conversationId);
        } else if (verdict?.current) {
          if (idleReminder) return;
          if (verdict.needsDeveloper) signal = needsDeveloperSignal(signal);
        }
      } else if (idleReminder) {
        // The provider's idle reminder follows every finished turn by about a minute. Where the
        // conductor already decided what that turn needs, the reminder adds nothing.
        if (this.verdicts.get(signal.conversationId)?.current) return;
      } else if (judge && (await judge.enabled().catch(() => false))) {
        signal = await this.judgeTurnEnd(signal, judge, options.loadReply);
        // The agent moved on while the verdict was out (the developer answered, a prompt came
        // up): the turn end is history, and announcing it now would only be late.
        if (this.sequence.get(signal.conversationId) !== turn) return;
      } else {
        this.retireVerdict(signal.conversationId);
      }
    } else {
      this.retireVerdict(signal.conversationId);
    }
    const status = deriveAgentStatus(signal);
    let context: ConversationContext;

    if (status) {
      const derivedSeen = status === 'working' ? 1 : 0;
      // Direct write is sanctioned: agent_status/agent_status_seen are a device-local
      // cache outside the registry's observation discipline (see schema comment).
      const [row] = await getAppDb()
        .update(conversations)
        .set(
          options.preserveSeen
            ? { agentStatus: status }
            : { agentStatus: status, agentStatusSeen: derivedSeen }
        )
        .where(eq(conversations.id, signal.conversationId))
        .returning({
          ...conversationContextSelection(),
          agentStatusSeen: conversations.agentStatusSeen,
        });
      if (!row) return;
      // Unlinked mirror rows have no task surface to notify.
      if (row.projectId === null || row.taskId === null) return;

      context = { projectId: row.projectId, taskId: row.taskId, providerId: row.providerId };
      publishConversationEvent({
        type: 'agent-status-changed',
        conversationId: signal.conversationId,
        taskId: row.taskId,
        projectId: row.projectId,
        status,
        seen: (row.agentStatusSeen ?? derivedSeen) === 1,
        // The final reply leaves the main process only redacted and bounded; reasoning and the
        // rest of the transcript never do.
        // A turn that ended needing the developer still reports what the agent said.
        ...(status === 'completed' || (turnEnded && status === 'awaiting-input')
          ? {
              completionSummary: summarizeCompletionMessage(signal.payload.lastAssistantMessage),
              completionReport: buildCompletionReport(signal.payload.lastAssistantMessage),
            }
          : {}),
      });
    } else {
      const [row] = await getAppDb()
        .select(conversationContextSelection())
        .from(conversations)
        .where(eq(conversations.id, signal.conversationId))
        .limit(1);
      if (!row) return;
      if (row.projectId === null || row.taskId === null) return;
      context = { projectId: row.projectId, taskId: row.taskId, providerId: row.providerId };
    }

    if (deliver) {
      this.hooks.callHookBackground('agent:event', {
        ...signal,
        providerId: signal.providerId ?? context.providerId ?? undefined,
        projectId: context.projectId,
        taskId: context.taskId,
      });
    }
  }

  /**
   * Asks the conductor whether the turn that just ended needs the developer. A yes turns the stop
   * into an attention notification, so the conversation goes to awaiting-input instead of
   * completed; a no, or no answer, leaves the stop as it is. The status stays where it was
   * (working) until this resolves, so nothing announces a finished agent that is in fact waiting.
   */
  private async judgeTurnEnd(
    signal: AgentStatusSignal,
    judge: AttentionJudge,
    loadReply: ApplyAgentStatusSignalOptions['loadReply']
  ): Promise<AgentStatusSignal> {
    const conversationId = signal.conversationId;
    this.retireVerdict(conversationId);
    let ended = signal;
    // Reading the reply and judging it share one deadline: the status waits on both.
    const outcome = await withTimeout(
      (async () => {
        const reply =
          signal.payload.lastAssistantMessage?.trim() ||
          (await loadReply?.().catch(() => null))?.trim() ||
          '';
        // Only the redacted, bounded reply leaves for the model, as for every other reader of it.
        const report = buildCompletionReport(reply);
        if (!report) return null;
        ended = { ...signal, payload: { ...signal.payload, lastAssistantMessage: reply } };
        const key = replyKey(report.text);
        const known = this.verdicts.get(conversationId);
        if (known?.replyKey === key) return { key, needsDeveloper: known.needsDeveloper };
        const verdict = await judge.judge({
          conversationId,
          providerId: signal.providerId,
          reply: report.text,
        });
        return verdict ? { key, needsDeveloper: verdict.needsDeveloper } : null;
      })(),
      VERDICT_TIMEOUT_MS
    ).catch(() => null);
    if (!outcome) return ended;
    this.verdicts.set(conversationId, {
      replyKey: outcome.key,
      needsDeveloper: outcome.needsDeveloper,
      current: true,
    });
    return outcome.needsDeveloper ? needsDeveloperSignal(ended) : ended;
  }

  private retireVerdict(conversationId: string): void {
    const verdict = this.verdicts.get(conversationId);
    if (verdict?.current) this.verdicts.set(conversationId, { ...verdict, current: false });
  }

  private async resetToIdleQueued(conversationId: string): Promise<void> {
    this.verdicts.delete(conversationId);
    const [row] = await getAppDb()
      .update(conversations)
      .set({ agentStatus: 'idle', agentStatusSeen: 1 })
      .where(
        and(
          eq(conversations.id, conversationId),
          inArray(conversations.agentStatus, ['working', 'awaiting-input'])
        )
      )
      .returning(conversationContextSelection());
    if (!row) return;
    if (row.projectId === null || row.taskId === null) return;

    publishConversationEvent({
      type: 'agent-status-changed',
      conversationId,
      taskId: row.taskId,
      projectId: row.projectId,
      status: 'idle',
      seen: true,
    });
  }

  private enqueue(conversationId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.queues.set(conversationId, current);
    void current.then(
      () => this.removeQueue(conversationId, current),
      () => this.removeQueue(conversationId, current)
    );
    return current;
  }

  private removeQueue(conversationId: string, queue: Promise<void>): void {
    if (this.queues.get(conversationId) !== queue) return;
    this.queues.delete(conversationId);
    this.sequence.delete(conversationId);
  }

  async dispose(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled(this.queues.values());
    }
  }
}

function replyKeyOf(message: string | undefined): string | null {
  const report = buildCompletionReport(message);
  return report ? replyKey(report.text) : null;
}

/** A finished turn that waits on the developer: an attention notification that keeps the reply. */
function needsDeveloperSignal(signal: AgentStatusSignal): AgentStatusSignal {
  return {
    ...signal,
    type: 'notification',
    payload: { ...signal.payload, notificationType: 'idle_prompt' },
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

export const agentStatusService = new AgentStatusService();
