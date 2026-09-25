import type Anthropic from '@anthropic-ai/sdk';

/** Conversation turns (user utterances) the conductor keeps as model context. */
export const MAX_HISTORY_TURNS = 8;

/**
 * Drops the oldest turns, cutting only at plain-text user messages (turn starts) so every
 * tool_use keeps its tool_result and the history stays a valid message sequence.
 */
export function trimHistory(
  messages: Anthropic.Beta.BetaMessageParam[],
  maxTurns = MAX_HISTORY_TURNS
): Anthropic.Beta.BetaMessageParam[] {
  const turnStarts = messages.flatMap((message, index) =>
    message.role === 'user' && typeof message.content === 'string' ? [index] : []
  );
  if (turnStarts.length <= maxTurns) return messages;
  const cut = turnStarts[turnStarts.length - maxTurns] ?? 0;
  return messages.slice(cut);
}
