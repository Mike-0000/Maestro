/** How long a typed line ending in ":" waits for the rest of the message. */
export const TYPED_MERGE_WINDOW_MS = 3000;

/** A bare reply that controls the conductor rather than continuing a message. */
const CONTROL_WORD = /^(stop|cancel|yes|no|wait)[.!]?$/i;

/** The control words that answer a pending confirmation. */
const ANSWER_WORD = /^(yes|no)[.!]?$/i;

/**
 * Typed lines that end in ":" announce more to come ("Need you to complete these actions:"). The
 * line is held briefly, and a submit that follows within the window joins it into one message.
 */
export function createTypedSubmitMerger(
  send: (text: string) => void,
  windowMs: number = TYPED_MERGE_WINDOW_MS,
  onHold: (held: string | null) => void = () => {}
): { submit: (text: string) => void; flush: () => void } {
  let held: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const text = held;
    held = null;
    onHold(null);
    if (text !== null) send(text);
  };

  const submit = (raw: string) => {
    // "stop" or "yes" answers something else; it is never the rest of the held message.
    if (held !== null && CONTROL_WORD.test(raw.trim())) {
      if (ANSWER_WORD.test(raw.trim())) {
        // A yes or no answers a confirmation that the held line's turn would clear, so it goes
        // first. stop, cancel and wait go after, or they would cancel the held line's own turn.
        send(raw.trim());
        flush();
        return;
      }
      flush();
    }
    const text = held === null ? raw.trim() : `${held}\n${raw.trim()}`;
    if (timer) clearTimeout(timer);
    timer = null;
    held = null;
    if (text.endsWith(':')) {
      held = text;
      timer = setTimeout(flush, windowMs);
      onHold(text);
    } else {
      onHold(null);
      send(text);
    }
  };

  return { submit, flush };
}

/** A pasted block is one message: line breaks become spaces rather than separate submits. */
export function collapsePastedLines(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}
