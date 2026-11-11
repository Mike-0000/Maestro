import type { ChatDigest } from '../../../api/chat-conductor/digest';
import type { ChatConductorEntry } from '../../../api/chat-conductor/thread';

/**
 * The conductor screen's thread as blocks to draw: the saved entries, with each run of actions
 * folded into one "Worked for …" disclosure, and every conductor line given its weight by how
 * recent it is. Pure, so the panel only maps blocks to components.
 */

export type LineEmphasis = 'latest' | 'recent' | 'old';

export type ActionEntry = Extract<ChatConductorEntry, { kind: 'action' }>;

export type ThreadBlock =
  | { kind: 'developer'; id: string; at: string; text: string }
  | {
      kind: 'line';
      id: string;
      at: string;
      text: string;
      emphasis: LineEmphasis;
      markdown: boolean;
    }
  | {
      kind: 'digest';
      id: string;
      at: string;
      digest: ChatDigest;
      askedAt: string | null;
      latest: boolean;
    }
  | {
      kind: 'work';
      id: string;
      actions: readonly ActionEntry[];
      steps: number;
      durationMs: number | null;
      failed: number;
      refused: number;
      openByDefault: boolean;
    }
  | { kind: 'event'; id: string; at: string; text: string }
  | { kind: 'error'; id: string; at: string; text: string };

/** Longer than this and a line is read, not glanced at: it renders as markdown in body type. */
const SPOKEN_MAX_CHARS = 280;

/** A line that opens a markdown block: a heading, quote, list item, fence, table row or rule. */
const BLOCK_START = /^\s{0,3}(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||(?:[-*_]\s*){3,}$)/;
/** Inline markdown plain text would show as punctuation: links, images, bold, italics by `_`. */
const INLINE_MARKUP = /\[[^\]]*\]\([^)]*\)|\*\*[^*]+\*\*|__[^_]+__|<[a-z][^>]*>/i;

/** Short and plain enough for large type: at most 280 characters, no block markdown. */
export function isSpokenLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > SPOKEN_MAX_CHARS) return false;
  if (trimmed.includes('\n')) return false;
  if (BLOCK_START.test(trimmed)) return false;
  return !INLINE_MARKUP.test(trimmed);
}

function timeOf(at: string | undefined): number | null {
  if (at === undefined) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/** How long a run of actions took: from the entry before it to the entry after it. */
function workDuration(
  before: ChatConductorEntry | undefined,
  after: ChatConductorEntry | undefined
) {
  const start = timeOf(before?.at);
  const end = timeOf(after?.at);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

export function buildThreadView(entries: readonly ChatConductorEntry[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    switch (entry.kind) {
      case 'developer':
        blocks.push({ kind: 'developer', id: entry.id, at: entry.at, text: entry.text });
        break;
      case 'conductor':
        blocks.push({
          kind: 'line',
          id: entry.id,
          at: entry.at,
          text: entry.text,
          emphasis: 'old',
          markdown: !isSpokenLine(entry.text),
        });
        break;
      case 'digest':
        blocks.push({
          kind: 'digest',
          id: entry.id,
          at: entry.at,
          digest: entry.digest,
          askedAt: entry.askedAt,
          latest: false,
        });
        break;
      case 'event':
      case 'error':
        blocks.push({ kind: entry.kind, id: entry.id, at: entry.at, text: entry.text });
        break;
      case 'action': {
        const actions: ActionEntry[] = [];
        let end = index;
        while (end < entries.length) {
          const next = entries[end]!;
          if (next.kind !== 'action') break;
          actions.push(next);
          end += 1;
        }
        const failed = actions.filter((action) => action.status === 'failed').length;
        const refused = actions.filter((action) => action.status === 'refused').length;
        blocks.push({
          kind: 'work',
          id: `work:${entry.id}`,
          actions,
          steps: actions.length,
          durationMs: workDuration(entries[index - 1], entries[end]),
          failed,
          refused,
          openByDefault: failed > 0 || refused > 0,
        });
        index = end - 1;
        break;
      }
    }
  }
  markLineEmphasis(blocks);
  markLatestDigest(blocks);
  return blocks;
}

/**
 * The last conductor line after the developer last wrote is `latest`; the two lines before it are
 * `recent`. With no line since the developer wrote, every line is `old`.
 */
function markLineEmphasis(blocks: ThreadBlock[]): void {
  let lastDeveloper = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]!.kind === 'developer') lastDeveloper = index;
  }
  const lines: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]!.kind === 'line') lines.push(index);
  }
  const latest = lines.at(-1);
  if (latest === undefined || latest < lastDeveloper) return;
  setEmphasis(blocks, latest, 'latest');
  for (const index of lines.slice(-3, -1)) setEmphasis(blocks, index, 'recent');
}

function setEmphasis(blocks: ThreadBlock[], index: number, emphasis: LineEmphasis): void {
  const block = blocks[index];
  if (block?.kind === 'line') blocks[index] = { ...block, emphasis };
}

function markLatestDigest(blocks: ThreadBlock[]): void {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'digest') {
      blocks[index] = { ...block, latest: true };
      return;
    }
  }
}

/** "Worked for 1m 34s · 4 steps · 1 refused · 1 failed". */
export function workLabel(block: Extract<ThreadBlock, { kind: 'work' }>): string {
  const parts: string[] = [];
  if (block.durationMs === null) parts.push('Worked');
  else if (block.durationMs < 1_000) parts.push('Worked for under 1s');
  else parts.push(`Worked for ${formatDuration(block.durationMs)}`);
  parts.push(block.steps === 1 ? '1 step' : `${block.steps} steps`);
  if (block.refused > 0) parts.push(`${block.refused} refused`);
  if (block.failed > 0) parts.push(`${block.failed} failed`);
  return parts.join(' · ');
}

/** "14s", "1m 34s", "2m", "2h 5m", "2h". Whole seconds, rounded down; nothing below 0s. */
export function formatDuration(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
