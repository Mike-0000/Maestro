import type { ThreadBlock } from './thread-view';

/**
 * The report the developer is answering now: the thread's newest digest, as long as they have not
 * written since it was posted. It reads as part of the conversation, with its actions; once the
 * developer moved on, it is history and draws back into a quiet card. Null when there is none.
 */
export function currentDigestId(blocks: readonly ThreadBlock[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'developer') return null;
    if (block.kind === 'digest') return block.latest ? block.id : null;
  }
  return null;
}
