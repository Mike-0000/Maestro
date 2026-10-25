import type Anthropic from '@anthropic-ai/sdk';

type Message = Anthropic.Beta.BetaMessageParam;

function toolUseIds(message: Message | undefined): string[] {
  if (message?.role !== 'assistant' || typeof message.content === 'string') return [];
  return message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
}

function resultIds(message: Message | undefined): Set<string> {
  if (message?.role !== 'user' || typeof message.content === 'string') return new Set();
  return new Set(
    message.content.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : []))
  );
}

/**
 * What of a request turn may be kept as history. Every tool call it kept has its results, and
 * the last word is the conductor's: a turn cut off between a call and its results (stopped,
 * or failed mid-round) loses that tail, and one that settled its request ends on `closing`.
 * `base` is where the turn's own messages begin. Null when nothing of the turn can be kept.
 */
export function keptRequestTurn(
  messages: readonly Message[],
  base: number,
  closing: string | null
): Message[] | null {
  const kept = messages.slice();
  for (let index = base; index < kept.length; index++) {
    const calls = toolUseIds(kept[index]);
    if (calls.length === 0) continue;
    const answered = resultIds(kept[index + 1]);
    if (!calls.every((id) => answered.has(id))) {
      kept.length = index;
      break;
    }
  }
  if (kept.length <= base) return null;
  if (kept.at(-1)?.role === 'user') {
    if (!closing) return null;
    kept.push({ role: 'assistant', content: closing });
  }
  return kept;
}
