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

/** Stands in for the state a past turn was sent with. */
export const CONTEXT_OMITTED =
  '<context>\n(The state at that time is omitted; the latest message carries the current state.)\n</context>';

/**
 * Replaces the <context> block of every stored turn with a short marker. Each new turn brings the
 * current roster and activity, so a past turn's copy is only stale state that costs tokens on
 * every later request; what the developer said stays.
 */
export function dropStaleContexts(
  messages: Anthropic.Beta.BetaMessageParam[]
): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return message;
    const end = message.content.indexOf('</context>');
    if (!message.content.startsWith('<context>') || end === -1) return message;
    return {
      ...message,
      content: CONTEXT_OMITTED + message.content.slice(end + '</context>'.length),
    };
  });
}

/** How a code check's result is fenced in a tool result (see investigation-format.ts). */
const CODE_CHECK_OPEN = '<code-check ';
/** Stands in for a code check's result once it is too old to plan from. */
export const CODE_CHECK_REMOVED = '[code check result removed]';
/** Marks a turn started by Maestro (a finished agent, an agent's request), not the developer. */
export const MAESTRO_EVENT_MARK = '[Maestro event, not the developer speaking]';
/** Developer turns a check's result stays in context for, after the turn that made it. */
export const CODE_CHECK_TURNS = 2;

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === 'text' ? (part.text ?? '') : ''
    )
    .join('');
}

function holdsCodeCheck(message: Anthropic.Beta.BetaMessageParam): boolean {
  if (message.role !== 'user' || typeof message.content === 'string') return false;
  return message.content.some(
    (block) =>
      block.type === 'tool_result' && toolResultText(block.content).includes(CODE_CHECK_OPEN)
  );
}

/**
 * True when a code check's result is in these messages: text a scout read from the repository is
 * then in front of the model, and what the model does next needs the developer's explicit yes.
 */
export function hasCodeCheck(messages: readonly Anthropic.Beta.BetaMessageParam[]): boolean {
  return messages.some(holdsCodeCheck);
}

/**
 * Replaces a code check's result with a one-line marker once the developer has made two more
 * requests since the turn that ran it. They keep the answer for that turn and their next two;
 * after that it is stale, and it no longer makes every action ask first. Turns Maestro started
 * (an agent finishing) do not use up the count.
 */
export function compactCodeChecks(
  messages: Anthropic.Beta.BetaMessageParam[],
  keepTurns = CODE_CHECK_TURNS
): Anthropic.Beta.BetaMessageParam[] {
  if (!hasCodeCheck(messages)) return messages;
  // For each message, how many developer turns start after it.
  const laterTurns = new Array<number>(messages.length).fill(0);
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    laterTurns[index] = count;
    const message = messages[index];
    if (
      message?.role === 'user' &&
      typeof message.content === 'string' &&
      !message.content.includes(MAESTRO_EVENT_MARK)
    ) {
      count++;
    }
  }
  return messages.map((message, index) => {
    if ((laterTurns[index] ?? 0) < keepTurns || !holdsCodeCheck(message)) return message;
    if (typeof message.content === 'string') return message;
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === 'tool_result' && toolResultText(block.content).includes(CODE_CHECK_OPEN)
          ? { ...block, content: CODE_CHECK_REMOVED }
          : block
      ),
    };
  });
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
