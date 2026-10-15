import type Anthropic from '@anthropic-ai/sdk';

/**
 * Where the conductor's prompt is cached. A request is tools, then the system prompt and the
 * standing instructions, then the conversation; a cache hit reads the longest prefix that ended at
 * a breakpoint written before.
 *
 * - The fixed prefix (tools, prompt, standing instructions) changes almost never, while the
 *   developer's turns come minutes apart: it is kept for an hour, not the default five minutes,
 *   so a turn after a pause still reads it.
 * - The conversation gets two breakpoints. The end of the stored history is the same bytes on
 *   the next turn (a stored turn's context block is already compacted), so the next turn reads
 *   the whole history from cache. The last message lets each tool round of a turn read everything
 *   the round before it sent.
 *
 * Anthropic allows four breakpoints, and an hour-long one must come before any five-minute one.
 */

export type MessageParam = Anthropic.Beta.BetaMessageParam;

/** The fixed prefix: kept an hour, since turns are often more than five minutes apart. */
export const PREFIX_CACHE = { type: 'ephemeral', ttl: '1h' } as const;
/** The conversation: it changes every turn, so the default lifetime. */
export const CONVERSATION_CACHE = { type: 'ephemeral' } as const;

/**
 * Index of the message that starts the current turn: the last user message that is plain text.
 * Tool results are block lists, so they never start a turn.
 */
export function turnStartIndex(messages: readonly MessageParam[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') return index;
  }
  return -1;
}

/**
 * The indexes that take a conversation breakpoint: the end of the stored history (the message
 * before the current turn starts) and the last message. Fewer when they coincide or are absent.
 */
export function conversationBreakpoints(messages: readonly MessageParam[]): number[] {
  const last = messages.length - 1;
  if (last < 0) return [];
  const historyEnd = turnStartIndex(messages) - 1;
  return historyEnd >= 0 && historyEnd !== last ? [historyEnd, last] : [last];
}

type Block = Anthropic.Beta.BetaContentBlockParam;

/** Blocks that cannot carry a cache marker, or that would carry it for nothing. */
function canMark(block: Block): boolean {
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
  if (block.type === 'text') return block.text.length > 0;
  return true;
}

/** A copy of one message with a breakpoint on its last block that can take one. */
function marked(message: MessageParam): MessageParam {
  if (typeof message.content === 'string') {
    if (!message.content) return message;
    return {
      ...message,
      content: [{ type: 'text', text: message.content, cache_control: CONVERSATION_CACHE }],
    };
  }
  const blocks = message.content as Block[];
  let target = -1;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block && canMark(block)) {
      target = index;
      break;
    }
  }
  if (target === -1) return message;
  return {
    ...message,
    content: blocks.map((block, index) =>
      index === target ? ({ ...block, cache_control: CONVERSATION_CACHE } as Block) : block
    ),
  };
}

/**
 * The conversation with its breakpoints, as a new array: the caller's messages are not changed,
 * and any marker they carried already is dropped so the request never holds more than four.
 */
export function withConversationBreakpoints(messages: readonly MessageParam[]): MessageParam[] {
  const breakpoints = new Set(conversationBreakpoints(messages));
  return messages.map((message, index) => {
    const clean = withoutMarkers(message);
    return breakpoints.has(index) ? marked(clean) : clean;
  });
}

function withoutMarkers(message: MessageParam): MessageParam {
  if (typeof message.content === 'string') return message;
  const blocks = message.content as Block[];
  if (!blocks.some((block) => 'cache_control' in block && block.cache_control)) return message;
  return {
    ...message,
    content: blocks.map((block) => {
      if (!('cache_control' in block) || !block.cache_control) return block;
      const { cache_control: _dropped, ...rest } = block;
      return rest as Block;
    }),
  };
}
