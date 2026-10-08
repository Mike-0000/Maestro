import type { SessionSummary } from '#runtimes/acp/api';
import type { AutomationSessionStatus } from '#runtimes/automations/api';
import type { TuiAgentState, TuiSessionState } from '#runtimes/tui-agents/api';

const UNKNOWN: AutomationSessionStatus = { state: 'unknown', clean: false };
const WORKING: AutomationSessionStatus = { state: 'working', clean: false };

/**
 * An ACP session is settled only once a turn has produced an outcome, so a session
 * that is still starting (no stop reason yet) never reads as finished.
 */
export function acpSessionStatus(summary: SessionSummary | undefined): AutomationSessionStatus {
  if (!summary) return UNKNOWN;

  const hasOutcome = summary.lastStopReason !== null || summary.lastTurnErrored;
  const busy =
    summary.isGenerating || summary.queuedPromptCount > 0 || summary.pendingPermissionCount > 0;
  if (hasOutcome && !busy) {
    return {
      state: 'settled',
      clean: summary.lastStopReason === 'end_turn' && !summary.lastTurnErrored,
      detail: summary.lastTurnErrored ? 'turn_errored' : (summary.lastStopReason ?? undefined),
    };
  }
  if (summary.lifecycle === 'closed') return { state: 'exited', clean: false };
  return WORKING;
}

export function tuiSessionStatus(
  agent: TuiAgentState | undefined,
  session: TuiSessionState | undefined
): AutomationSessionStatus {
  if (!agent && !session) return UNKNOWN;
  if (session?.exit && agent?.status !== 'completed') {
    return { state: 'exited', clean: false, detail: `exit_${session.exit.exitCode ?? 'signal'}` };
  }
  if (!agent) return UNKNOWN;

  switch (agent.status) {
    case 'working':
      return WORKING;
    case 'idle':
    case 'completed':
      return { state: 'settled', clean: true, detail: agent.status };
    case 'awaiting-input':
    case 'error':
      return { state: 'settled', clean: false, detail: agent.status };
  }
}
