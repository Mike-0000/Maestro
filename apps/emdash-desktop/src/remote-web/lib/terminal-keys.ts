/** Keys a phone keyboard lacks, offered on the key bar. */
export type TerminalKey =
  | 'escape'
  | 'enter'
  | 'tab'
  | 'shift-tab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ctrl-c';

export type TerminalInputModes = {
  /** DECCKM: full-screen programs switch the arrow keys to their `SS3` form. */
  applicationCursorKeys: boolean;
  /** The program asked for pasted text to be wrapped so it can tell it from typing. */
  bracketedPaste: boolean;
};

const ESC = '\x1b';
const ARROW_FINAL: Record<'up' | 'down' | 'right' | 'left', string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/** The bytes a real terminal sends for `key` in the program's current input mode. */
export function encodeTerminalKey(
  key: TerminalKey,
  modes: Pick<TerminalInputModes, 'applicationCursorKeys'>
): string {
  switch (key) {
    case 'escape':
      return ESC;
    case 'enter':
      return '\r';
    case 'tab':
      return '\t';
    case 'shift-tab':
      return `${ESC}[Z`;
    case 'ctrl-c':
      return '\x03';
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return `${ESC}${modes.applicationCursorKeys ? 'O' : '['}${ARROW_FINAL[key]}`;
  }
}

/**
 * Encodes composed text the way a terminal pastes it: line breaks become carriage returns and,
 * when the program supports it, the text is bracketed so a multi-line prompt arrives as one
 * paste instead of submitting at its first line break. Returns '' when there is nothing to send.
 */
export function encodePastedText(
  text: string,
  modes: Pick<TerminalInputModes, 'bracketedPaste'>
): string {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\s+$/g, '')
    // A paste terminator inside the text would end the paste early and run the rest as keys.
    .replaceAll(`${ESC}[201~`, '')
    .replace(/\n/g, '\r');
  if (!body) return '';
  return modes.bracketedPaste ? `${ESC}[200~${body}${ESC}[201~` : body;
}

/** Pause between pasting a prompt and pressing Enter, so the program sees two separate events. */
export const SUBMIT_DELAY_MS = 80;
export const SUBMIT_SEQUENCE = '\r';
