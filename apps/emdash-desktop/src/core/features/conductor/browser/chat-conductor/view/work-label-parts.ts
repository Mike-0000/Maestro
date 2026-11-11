import { workLabel, type ThreadBlock } from './thread-view';

/**
 * The "Worked for …" label in parts, so the steps that were refused or failed can carry their own
 * tone. Joined with " · " the parts read exactly as `workLabel`.
 */
export type WorkLabelPart = { text: string; tone: 'plain' | 'warning' | 'error' };

export function workLabelParts(block: Extract<ThreadBlock, { kind: 'work' }>): WorkLabelPart[] {
  const parts: WorkLabelPart[] = [
    { text: workLabel({ ...block, refused: 0, failed: 0 }), tone: 'plain' },
  ];
  // The same words `workLabel` adds, cut off from the plain part so each keeps its tone.
  const full = workLabel(block);
  const extra = full.slice(parts[0]!.text.length).split(' · ').filter(Boolean);
  for (const text of extra) {
    parts.push({ text, tone: text.endsWith('failed') ? 'error' : 'warning' });
  }
  return parts;
}
