import type { AgentStatus, NotificationType } from '@core/primitives/agents/api/agent-events';
import type { CloseScope } from './grammar';

/**
 * Pure decisions behind voice window management: which windows a bulk close hides, which a bare
 * "reopen" restores, and when typing into an agent would answer its permission prompt.
 */
export type WindowAgent = {
  readonly conversationId: string;
  readonly type: 'pty' | 'acp';
  readonly status: AgentStatus;
  readonly notificationType: NotificationType | null;
  readonly sessionActive: boolean;
};

/** Done, failed, or no longer running: safe to put away. */
export function isFinished(agent: WindowAgent): boolean {
  if (agent.status === 'completed' || agent.status === 'error') return true;
  return !agent.sessionActive && agent.status !== 'awaiting-input';
}

/**
 * The visible agents a bulk close hides. Returns null for "close the others" with nothing
 * focused, since there is no "this one" to keep.
 */
export function closeTargets(
  visible: readonly WindowAgent[],
  scope: CloseScope,
  focusedId: string | null
): string[] | null {
  switch (scope) {
    case 'all':
      return visible.map((agent) => agent.conversationId);
    case 'others':
      if (!focusedId) return null;
      return visible
        .filter((agent) => agent.conversationId !== focusedId)
        .map((agent) => agent.conversationId);
    case 'done':
      return visible.filter(isFinished).map((agent) => agent.conversationId);
  }
}

/**
 * What a bare "reopen" restores: the last batch the conductor closed when all of it is still
 * hidden, else the most recently hidden agent (the hide list is append-ordered).
 */
export function reopenTargets(
  hiddenIds: readonly string[],
  lastClosedBatch: readonly string[]
): string[] {
  const hidden = new Set(hiddenIds);
  if (lastClosedBatch.length > 0 && lastClosedBatch.every((id) => hidden.has(id))) {
    return [...lastClosedBatch];
  }
  const last = hiddenIds[hiddenIds.length - 1];
  return last ? [last] : [];
}

/**
 * True when text sent to this agent would land on a permission prompt. Terminal agents read
 * digits and Enter as menu choices there, so a stray message could approve the request.
 */
export function atPermissionPrompt(agent: WindowAgent): boolean {
  return (
    agent.type === 'pty' &&
    agent.status === 'awaiting-input' &&
    agent.notificationType === 'permission_prompt'
  );
}

/** "Atlas", "Atlas and Bravo", "Atlas, Bravo, and 2 more". */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length <= max) return `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`;
  return `${names.slice(0, max - 1).join(', ')}, and ${names.length - (max - 1)} more`;
}
