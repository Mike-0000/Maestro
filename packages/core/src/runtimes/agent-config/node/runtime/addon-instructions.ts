/**
 * The block an add-on keeps inside a shared instructions file such as `CLAUDE.md`. Markers bound
 * it so install, update, and removal touch only the add-on's own lines and leave everything the
 * developer wrote around it byte for byte. Callers validate `id` (lowercase letters, digits, and
 * dashes), so it is safe inside a pattern.
 */

function startMarker(id: string): string {
  return `<!-- maestro-addon:${id}:start (managed by Maestro: Settings > Add-ons) -->`;
}

function endMarker(id: string): string {
  return `<!-- maestro-addon:${id}:end -->`;
}

function blockPattern(id: string): RegExp {
  return new RegExp(
    `<!-- maestro-addon:${id}:start[^\\r\\n]*?-->\\r?\\n([\\s\\S]*?)\\r?\\n?<!-- maestro-addon:${id}:end -->`
  );
}

function lineEnding(text: string | null): string {
  return text?.includes('\r\n') ? '\r\n' : '\n';
}

/** The block's body, or null when the file holds no block for `id`. */
export function readInstructionBlock(text: string | null, id: string): string | null {
  if (text === null) return null;
  const match = blockPattern(id).exec(text);
  return match ? (match[1] ?? '') : null;
}

/** Put `content` in the block for `id`: replaced in place when present, appended otherwise. */
export function applyInstructionBlock(text: string | null, id: string, content: string): string {
  const eol = lineEnding(text);
  const body = content.trim().replace(/\r?\n/g, eol);
  const block = `${startMarker(id)}${eol}${body}${eol}${endMarker(id)}`;
  if (text === null || text.trim() === '') return `${block}${eol}`;
  const pattern = blockPattern(id);
  if (pattern.test(text)) return text.replace(pattern, () => block);
  const separator = text.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${text}${separator}${block}${eol}`;
}

/** Take the block for `id` out, with the blank line that separated it from the text before. */
export function removeInstructionBlock(text: string, id: string): string {
  const match = blockPattern(id).exec(text);
  if (!match) return text;
  const eol = lineEnding(text);
  let before = text.slice(0, match.index);
  let after = text.slice(match.index + match[0].length);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  if (before.endsWith(`${eol}${eol}`)) before = before.slice(0, -eol.length);
  const result = `${before}${after}`;
  return result.trim() === '' ? '' : result;
}
