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

/** Stands in for a screenshot dropped from context. */
export const SCREENSHOT_OMITTED = '[screenshot omitted]';

/**
 * Replaces screenshots in tool results with a short marker, except those in the last `keep`
 * messages that carry any. Screenshots cost about a thousand tokens each; only the latest one is
 * worth sending again, and stored history keeps none (`keep = 0`).
 */
export function pruneScreenshots(
  messages: Anthropic.Beta.BetaMessageParam[],
  keep = 1
): Anthropic.Beta.BetaMessageParam[] {
  const withImages = messages.flatMap((message, index) => (hasScreenshot(message) ? [index] : []));
  const kept = new Set(keep > 0 ? withImages.slice(-keep) : []);
  return messages.map((message, index) =>
    kept.has(index) || !withImages.includes(index) ? message : stripScreenshots(message)
  );
}

function hasScreenshot(message: Anthropic.Beta.BetaMessageParam): boolean {
  if (typeof message.content === 'string') return false;
  return message.content.some(
    (block) =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some((part) => part.type === 'image')
  );
}

function stripScreenshots(
  message: Anthropic.Beta.BetaMessageParam
): Anthropic.Beta.BetaMessageParam {
  if (typeof message.content === 'string') return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
      return {
        ...block,
        content: block.content.map((part) =>
          part.type === 'image' ? { type: 'text' as const, text: SCREENSHOT_OMITTED } : part
        ),
      };
    }),
  };
}
