/**
 * Span selection: Jev picks which words of an utterance are the message for a coding agent, so a
 * send or spawn can pass the developer's own words through verbatim instead of waiting on Claude
 * to re-type them. The utterance is cut into sentences and clause starts; Jev chooses a start, an
 * end, and which sentences in between were meant for Chorus rather than for the agent.
 */

/** One sentence of the utterance, with its character range in the original text. */
export type Sentence = { readonly index: number; readonly start: number; readonly end: number };

/** Span questions cover at most this many sentences; the rest joins the last one. */
export const MAX_SPAN_SENTENCES = 30;
/** Bound on body-start candidates (one Choice). */
export const MAX_START_CANDIDATES = 60;
/** Option id for "the whole utterance". */
export const WHOLE_UTTERANCE = '(whole utterance)';
/** Option id for "to the end of the utterance". */
export const END_OF_UTTERANCE = '(end of utterance)';

/** Splits text into sentences at . ! ? followed by whitespace, and at line breaks. */
export function splitSentences(text: string, max = MAX_SPAN_SENTENCES): Sentence[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  const push = (end: number) => {
    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed) ranges.push({ start: start + lead, end: start + lead + trimmed.length });
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      push(i);
      start = i + 1;
      continue;
    }
    if (char !== '.' && char !== '!' && char !== '?') continue;
    let j = i;
    while (j + 1 < text.length && /[.!?"”')]/.test(text[j + 1] ?? '')) j++;
    const next = text[j + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    push(j + 1);
    start = j + 1;
    i = j;
  }
  push(text.length);
  if (ranges.length > max) {
    const last = ranges[max - 1];
    const tail = ranges[ranges.length - 1];
    if (last && tail) ranges.splice(max - 1, ranges.length, { start: last.start, end: tail.end });
  }
  return ranges.map((range, index) => ({ index, ...range }));
}

/** A place the agent's message could begin. */
export type SpanStart = { readonly offset: number; readonly sentence: number };

/**
 * Phrases after which the message itself tends to begin: "tell Maple to …", "saying …",
 * "with the prompt: …", "an agent to …". The message starts right after the match.
 */
const LEAD_IN =
  /(?:\b(?:that|saying|say|to say|prompt(?:ing)?(?: it)?(?: with)?|the prompt is|message|task is|instructions? (?:is|are))\b[\s,:]*|\btell\s+\S+(?:\s+\d+)?\s+(?:to|that)?\s*|\b(?:agent|one|it|them)\s+(?:to|and have it|and tell it to|that will)\s+|\bto\s+|[:—–]\s*|["“]\s*)/gi;

/** Candidate starts: every sentence start, plus clause starts after a lead-in phrase. */
export function spanStarts(text: string, sentences: readonly Sentence[]): SpanStart[] {
  const starts = new Map<number, SpanStart>();
  for (const sentence of sentences) {
    starts.set(sentence.start, { offset: sentence.start, sentence: sentence.index });
  }
  for (const sentence of sentences) {
    const body = text.slice(sentence.start, sentence.end);
    for (const match of body.matchAll(LEAD_IN)) {
      const offset = sentence.start + (match.index ?? 0) + match[0].length;
      if (offset >= sentence.end - 1 || starts.has(offset)) continue;
      starts.set(offset, { offset, sentence: sentence.index });
      if (starts.size >= MAX_START_CANDIDATES) break;
    }
    if (starts.size >= MAX_START_CANDIDATES) break;
  }
  return [...starts.values()].sort((a, b) => a.offset - b.offset);
}

function preview(text: string, words: number, fromEnd = false): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= words) return parts.join(' ');
  return fromEnd ? `…${parts.slice(-words).join(' ')}` : `${parts.slice(0, words).join(' ')}…`;
}

/** Option labels for the start Choice (unique, readable), mapped to their start. */
export function startOptions(
  text: string,
  sentences: readonly Sentence[],
  starts: readonly SpanStart[]
): Map<string, SpanStart> {
  const options = new Map<string, SpanStart>();
  const first = sentences[0];
  if (first) options.set(WHOLE_UTTERANCE, { offset: first.start, sentence: 0 });
  starts.forEach((start, index) => {
    const sentence = sentences[start.sentence];
    if (!sentence) return;
    options.set(`#${index} ${preview(text.slice(start.offset, sentence.end), 8)}`, start);
  });
  return options;
}

/** Option labels for the end Choice, mapped to the index of the last sentence kept. */
export function endOptions(text: string, sentences: readonly Sentence[]): Map<string, number> {
  const options = new Map<string, number>();
  options.set(END_OF_UTTERANCE, sentences.length - 1);
  for (const sentence of sentences) {
    options.set(
      `#${sentence.index} ${preview(text.slice(sentence.start, sentence.end), 8, true)}`,
      sentence.index
    );
  }
  return options;
}

/**
 * The message: from `start` to the end of sentence `end`, without whole sentences in between that
 * Jev judged to be meant for Chorus (probability ≥ 0.5). Words are the developer's own.
 */
export function assembleBody(
  text: string,
  sentences: readonly Sentence[],
  start: SpanStart,
  end: number,
  meta: ReadonlyMap<number, number>
): string {
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.index < start.sentence || sentence.index > end) continue;
    if (sentence.index === start.sentence) {
      pieces.push(text.slice(start.offset, sentence.end));
      continue;
    }
    if ((meta.get(sentence.index) ?? 0) >= 0.5) continue;
    pieces.push(text.slice(sentence.start, sentence.end));
  }
  return tidyBody(pieces.join(' '));
}

/** Drops quote marks and dangling connective punctuation around an extracted message. */
export function tidyBody(body: string): string {
  let text = body.trim();
  text = text.replace(/^[\s,:;—–-]+/, '');
  text = text
    .replace(/^["“'‘]+/, '')
    .replace(/["”'’]+$/, '')
    .trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const FILLER =
  /^(?:(?:ok(?:ay)?|so|um+|uh+|please|now|and|then|also|just|can you|could you|i want you to|i'?d like you to|go ahead and|let'?s)\b[\s,]*)+/i;

/** A task name from a message: its first clause, without filler, at most 60 characters. */
export function taskNameFrom(body: string, fallback: string): string {
  const clause = body
    .split(/[.!?;:\n]|,\s|\s[—–-]\s/)[0]
    ?.replace(FILLER, '')
    .trim();
  if (!clause) return fallback;
  const words = clause.split(/\s+/);
  let name = '';
  for (const word of words) {
    if (`${name} ${word}`.trim().length > 60) break;
    name = `${name} ${word}`.trim();
  }
  if (!name) name = clause.slice(0, 60);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
