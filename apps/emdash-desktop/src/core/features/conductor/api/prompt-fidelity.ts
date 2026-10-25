/**
 * Keeps a dictated brief intact on its way to a coding agent. The conductor writes an organized
 * prompt from what the developer said, but a model summary drops detail (examples, emphasis,
 * asides) exactly when the developer spoke at length. For those requests the agent also gets the
 * developer's own words, so nothing they said depends on the summary.
 */

/** Utterances at least this long are briefs worth passing on verbatim. */
export const VERBATIM_MIN_WORDS = 50;

export const VERBATIM_HEADING =
  "The developer's original request, verbatim from a voice transcript. It may contain " +
  'speech-to-text errors and parts meant for Chorus or other agents; the brief above is your task, ' +
  'and this keeps every detail they gave:';

/** The heading when no brief came with the request, so the transcript itself is the task. */
export const VERBATIM_HEADING_NO_BRIEF =
  "The developer's request, verbatim from a voice transcript. It may contain speech-to-text " +
  'errors and parts meant for Chorus or other agents; work out your task from it:';

/** A prompt that carries at least this share of the utterance's words, in order, is a full copy. */
const COPY_WORD_SHARE = 0.9;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** Words that reverse or limit a request: losing one changes what the agent is told to do. */
const QUALIFIERS = new Set([
  'not',
  'never',
  'no',
  'nothing',
  'none',
  'nor',
  'neither',
  'only',
  'except',
  'without',
  'unless',
  'cannot',
  'avoid',
]);

function isQualifier(word: string): boolean {
  return QUALIFIERS.has(word) || word.endsWith("n't");
}

const STOPWORDS = new Set(
  'a an and or of to in on at for it is are was were be been that this the with as but so if then than i you we they he she its my your our me um uh like just really also'.split(
    ' '
  )
);
/** A copy may miss at most this many content words, whatever its length. */
const MAX_MISSING_CONTENT_WORDS = 2;

/**
 * Whether the prompt keeps the utterance's words in order: at least the copy share of them, no
 * more than a couple of content words missing, and every negation or qualifier word present.
 */
function followsUtterance(prompt: string, utterance: string): boolean {
  const spoken = words(utterance);
  if (spoken.length === 0) return false;
  const written = words(prompt);
  const present = new Set(written);
  let at = 0;
  let matched = 0;
  let missingContent = 0;
  for (const word of spoken) {
    if (isQualifier(word) && !present.has(word)) return false;
    const found = written.indexOf(word, at);
    if (found < 0) {
      if (!STOPWORDS.has(word)) missingContent++;
      continue;
    }
    matched++;
    at = found + 1;
  }
  return matched / spoken.length >= COPY_WORD_SHARE && missingContent <= MAX_MISSING_CONTENT_WORDS;
}

/** Numbers, paths, URLs and identifier-like tokens: the details a summary tends to drop. */
function exactTokens(utterance: string): string[] {
  const found = new Set<string>();
  for (const raw of utterance.split(/\s+/)) {
    const token = raw.replace(/^[("'`[]+|[.,;:!?)"'`\]]+$/g, '');
    if (!token) continue;
    const identifier =
      /\d/.test(token) ||
      /[\\/]/.test(token) ||
      /[a-z][A-Z]/.test(token) ||
      token.includes('_') ||
      /\w\.\w/.test(token);
    if (identifier) found.add(token.toLowerCase());
  }
  return [...found];
}

/** True when the prompt already carries the utterance: nearly every word in order, every detail. */
function containsUtterance(prompt: string, utterance: string): boolean {
  if (!followsUtterance(prompt, utterance)) return false;
  const lower = prompt.toLowerCase();
  return exactTokens(utterance).every((token) => lower.includes(token));
}

/**
 * Appends the developer's verbatim request to an agent prompt when the request was a long,
 * dictated brief that the prompt does not already quote. Short commands pass through unchanged.
 */
export function withVerbatimRequest(prompt: string, utterance: string): string {
  const spoken = utterance.trim();
  if (words(spoken).length < VERBATIM_MIN_WORDS) return prompt;
  if (containsUtterance(prompt, spoken)) return prompt;
  const body = prompt.trim();
  const heading = body ? VERBATIM_HEADING : VERBATIM_HEADING_NO_BRIEF;
  return `${body ? `${body}\n\n---\n\n` : ''}${heading}\n\n"""\n${spoken}\n"""`;
}

/**
 * A tool error for spawn_agent when the prompt is empty although the developer gave a long,
 * detailed request: an empty prompt is only for "open an agent" with no work.
 */
export function emptyBriefError(prompt: string, utterance: string): string | null {
  if (prompt.trim() || words(utterance).length < VERBATIM_MIN_WORDS) return null;
  return (
    'The prompt is empty, but the developer gave a detailed request. Write the brief for the ' +
    'agent from what they said, then call spawn_agent again.'
  );
}

/**
 * What an agent actually received, for the tool result: lets the conductor report delivery
 * precisely ("the full 1,612-character brief") instead of assuming it.
 */
export function deliveryNote(written: string, delivered: string): string {
  const size = `${delivered.trim().length.toLocaleString('en-US')} characters`;
  return delivered === written ? size : `${size}, with the developer's verbatim request attached`;
}

/** A short description of a prompt for a confirmation label: its size and first words. */
export function describePrompt(prompt: string, maxPreview = 60): string {
  const text = prompt.trim();
  if (!text) return 'no prompt';
  const firstLine = text.split(/\r?\n/, 1)[0]!.trim();
  const preview =
    firstLine.length <= maxPreview ? firstLine : `${firstLine.slice(0, maxPreview - 1)}…`;
  return `${text.length.toLocaleString('en-US')}-character prompt: “${preview}”`;
}
