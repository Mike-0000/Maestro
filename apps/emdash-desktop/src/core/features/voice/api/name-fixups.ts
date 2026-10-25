/**
 * Product names the on-device speech model keeps mishearing. Only whole phrases are matched, never
 * a bare "cloud" or "codec", which are ordinary words.
 */
const NAME_FIXUPS: readonly (readonly [heard: string, name: string])[] = [
  // "Google Cloud Code" is a real product; see the lookbehind below.
  ['cloud code', 'Claude Code'],
  ['clawed code', 'Claude Code'],
  ['claud code', 'Claude Code'],
  ['codec agent', 'Codex agent'],
  ['mdash', 'Emdash'],
  ['omypy', 'oh-my-pi'],
  ['oh my pie', 'oh-my-pi'],
];

const FIXUP_PATTERNS = NAME_FIXUPS.map(
  ([heard, name]) =>
    [
      new RegExp(
        `${heard === 'cloud code' ? '(?<!\\bgoogle\\s+)' : ''}\\b${heard.replace(/ /g, '\\s+')}\\b`,
        'gi'
      ),
      name,
    ] as const
);

/** Names worth adding to a speech engine's vocabulary hint. */
export const VOICE_NAME_HINTS: readonly string[] = ['Claude Code', 'Codex', 'Emdash', 'oh-my-pi'];

/** Corrects known misheard product names in a final transcript. */
export function fixTranscriptNames(text: string): string {
  let fixed = text;
  for (const [pattern, name] of FIXUP_PATTERNS) fixed = fixed.replace(pattern, name);
  return fixed;
}
