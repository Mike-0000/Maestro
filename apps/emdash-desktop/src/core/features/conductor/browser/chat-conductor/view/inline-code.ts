/**
 * Text cut into plain runs and inline code spans, for a digest's fields: a span between two
 * backticks on one line is code, everything else is plain text. Nothing else is parsed, and a
 * backtick without its pair stays in the text as written.
 */
export type InlinePart = { code: boolean; text: string };

const SPAN = /`([^`\n]+)`/g;

export function inlineCodeParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pushText = (value: string) => {
    if (value.length === 0) return;
    const last = parts.at(-1);
    if (last && !last.code) last.text += value;
    else parts.push({ code: false, text: value });
  };
  let from = 0;
  for (const match of text.matchAll(SPAN)) {
    pushText(text.slice(from, match.index));
    parts.push({ code: true, text: match[1]! });
    from = match.index + match[0].length;
  }
  pushText(text.slice(from));
  return parts;
}
