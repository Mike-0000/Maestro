import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import type { ChatConductorStatus } from './chat-conductor/thread';

/** One of the task's chats, as the sidebar subtitle needs it. */
export type TaskSubtitleChat = {
  readonly status: AgentStatus;
  /** Few-word synopsis of what the agent finished (`AgentTileEntry.completionSummary`). */
  readonly completionSummary: string | null;
  /** The chat conductor's decision headline (`AgentTileEntry.conductor?.headline`). */
  readonly decisionHeadline: string | null;
  /** Sub-agents running inside the chat's session. */
  readonly helpers: number;
  /** What the first of them is doing, when the host names it. */
  readonly helperLabel: string | null;
};

/**
 * The second line of a task's sidebar row, or null for none. In order: the task conductor's
 * status headline unless it is idle; the helpers of a working chat ("2 helpers · Reading
 * flow4_v2.png", "1 helper"); the newest decision headline; the newest completion summary as a
 * sentence; "On <branch>".
 *
 * `chats` come newest first: the first chat with a decision headline or a completion summary is
 * the one shown.
 */
export function taskSubtitle(input: {
  status: ChatConductorStatus | null;
  chats: readonly TaskSubtitleChat[];
  branchName: string | null;
}): string | null {
  const { status, chats, branchName } = input;

  const conductorHeadline = clean(status?.headline);
  if (status && status.state !== 'idle' && conductorHeadline) return conductorHeadline;

  const helpers = helpersText(chats);
  if (helpers) return helpers;

  for (const chat of chats) {
    const headline = clean(chat.decisionHeadline);
    if (headline) return headline;
  }

  for (const chat of chats) {
    const summary = clean(chat.completionSummary);
    if (summary) return asSentence(summary);
  }

  const branch = clean(branchName);
  return branch ? `On ${branch}` : null;
}

/** The helpers of the task's working chats, with the first label any of them has. */
function helpersText(chats: readonly TaskSubtitleChat[]): string | null {
  let count = 0;
  let label: string | null = null;
  for (const chat of chats) {
    if (chat.status !== 'working') continue;
    const helpers = Number.isFinite(chat.helpers) ? Math.max(0, Math.floor(chat.helpers)) : 0;
    if (helpers === 0) continue;
    count += helpers;
    label ??= clean(chat.helperLabel);
  }
  if (count === 0) return null;
  const head = `${count} helper${count === 1 ? '' : 's'}`;
  return label ? `${head} · ${label}` : head;
}

/** "fixed the login flow" -> "Fixed the login flow." */
function asSentence(text: string): string {
  const capitalised = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…]$/u.test(capitalised) ? capitalised : `${capitalised}.`;
}

function clean(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/gu, ' ').trim();
  return trimmed ? trimmed : null;
}
