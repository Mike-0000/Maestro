import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import type { CompletionReport } from '@core/primitives/agents/api/completion-report';

/** What a chat conductor reads of its agent's live state. */
export type AgentSnapshot = {
  status: AgentStatus;
  report: CompletionReport | null;
  notification: string | null;
};

export type AgentEventSignal = {
  kind: 'finished' | 'awaiting-input' | 'error';
  /** Identity of the event, stable across restarts and re-renders of the same state. */
  key: string;
};

/** FNV-1a, as base 36: enough to tell two replies apart, and nothing of the text is kept. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The chat event an agent state stands for, or null while the agent is idle or working.
 *
 * A turn that ended on something the developer must answer arrives as awaiting-input with the
 * reply attached (see `endedTurn` in the conductor's roster): that is a finished turn, with the
 * same key as the completed state it replaces, so the two are handled once.
 */
export function agentEventSignal(snapshot: AgentSnapshot): AgentEventSignal | null {
  const { status, report } = snapshot;
  if (status === 'completed' || (status === 'awaiting-input' && report !== null)) {
    return {
      kind: 'finished',
      key: report ? `finished:${textHash(report.text)}` : 'finished:none',
    };
  }
  if (status === 'awaiting-input') {
    return { kind: 'awaiting-input', key: `awaiting-input:${snapshot.notification ?? ''}` };
  }
  if (status === 'error') return { kind: 'error', key: 'error' };
  return null;
}

/**
 * True only while a permission prompt is what the agent shows. Answering one presses a key in the
 * terminal, so this must not hold for a turn that merely ended on a question (awaiting-input with
 * the reply attached) or for a status restored without its notification.
 */
export function showsPermissionPrompt(snapshot: AgentSnapshot): boolean {
  return (
    snapshot.status === 'awaiting-input' &&
    snapshot.notification === 'permission_prompt' &&
    snapshot.report === null
  );
}
