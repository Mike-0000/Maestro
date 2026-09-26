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

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when the prompt already carries the utterance word for word (ignoring punctuation). */
function containsUtterance(prompt: string, utterance: string): boolean {
  const needle = words(utterance).join(' ');
  return needle.length > 0 && words(prompt).join(' ').includes(needle);
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
  return `${body ? `${body}\n\n---\n\n` : ''}${VERBATIM_HEADING}\n\n"""\n${spoken}\n"""`;
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
