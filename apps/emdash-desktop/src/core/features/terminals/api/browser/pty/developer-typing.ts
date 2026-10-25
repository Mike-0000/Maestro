import { parsePtySessionId } from '@core/primitives/pty/api';

/**
 * What the developer has typed into each agent's terminal, from their own keys only.
 *
 * Fed from the xterm input path (`usePty`), so it sees keystrokes, Shift+Enter, clipboard pastes
 * and attachment paths, and never what the app writes to the PTY itself: the conductor's pastes,
 * Enters and dictation go straight to the host. The terminal's own replies to the program (focus
 * events, mouse reports, device-attribute and cursor-position answers) travel the same xterm path
 * and are dropped here, so focusing a tile or a TUI querying the terminal is not typing.
 *
 * Whether text is waiting unsent is read from the keys, never from the screen: a TUI's
 * placeholder looks like typed text. The keys are followed only while they can be: history recall,
 * completion, search or a single Escape change the input in ways keys do not show, and the draft
 * is then unknown until something certainly empties it (Enter, Ctrl+U, Ctrl+C, Escape twice).
 * Unknown never counts as unsent text, so a misread draft cannot hold messages for long.
 *
 * Keyed by conversation id (the leaf of an agent's PTY session id).
 */
export interface DeveloperTyping {
  /** When the developer last pressed a key in this terminal (epoch ms); null when never. */
  lastKeystrokeAt: number | null;
  /** True when that last key was Enter (a submit). */
  lastKeyWasSubmit: boolean;
  /** When they last pressed Enter there; null when they have not. */
  lastSubmitAt: number | null;
  /** What the keys say the input holds: nothing, typed text, or something they cannot tell. */
  draft: 'empty' | 'text' | 'unknown';
  /**
   * Whether text certainly sits in the input that was neither sent nor cleared: text the
   * developer typed, or words the conductor left there without pressing Enter.
   */
  unsentText: boolean;
}

/** Fewer typed characters than this are a keypress answer ("1", "y"), not a draft. */
const DRAFT_MIN_CHARS = 2;
/** Two Escapes this close together clear the input in Claude Code. */
const DOUBLE_ESCAPE_MS = 800;

interface TypingState {
  lastKeystrokeAt: number | null;
  lastKeyWasSubmit: boolean;
  lastSubmitAt: number | null;
  /** The text typed since the input was last emptied; null when the keys lost track of it. */
  draft: string | null;
  /** The cursor left the end of the draft: its length is still known, its word ends are not. */
  cursorMoved: boolean;
  /** Words the conductor dictated into the input that nothing has submitted or cleared yet. */
  dictated: boolean;
  /** A message the conductor pasted that the agent did not take (see `noteUnsentMessage`). */
  unsentMessage: boolean;
  /** Inside a bracketed paste, where Enter is a newline, not a submit. */
  inPaste: boolean;
  lastEscapeAt: number | null;
}

const records = new Map<string, TypingState>();

type Key =
  | { kind: 'insert'; text: string }
  | { kind: 'submit' }
  | { kind: 'backspace' }
  | { kind: 'delete-word' }
  | { kind: 'delete-forward' }
  | { kind: 'clear' }
  | { kind: 'escape' }
  /** Moves the cursor within the input. */
  | { kind: 'move' }
  /** Changes the input in a way keys cannot follow (history, completion, search). */
  | { kind: 'unknown' }
  /** A key that leaves the input as it was (function keys, page keys). */
  | { kind: 'other' }
  | { kind: 'paste-start' }
  | { kind: 'paste-end' };

/** The conversation an agent PTY session belongs to; the id itself when it is not one. */
function conversationOf(sessionId: string): string {
  return parsePtySessionId(sessionId)?.leafId ?? sessionId;
}

/** Index just past the string terminator (BEL or ESC \) that ends a sequence starting at `from`. */
function stringEnd(data: string, from: number): number {
  for (let index = from; index < data.length; index++) {
    if (data[index] === '\x07') return index + 1;
    if (data[index] === '\x1b' && data[index + 1] === '\\') return index + 2;
  }
  return data.length;
}

/** A single control or printable character outside a paste. */
function plainKey(ch: string): Key {
  if (ch === '\r') return { kind: 'submit' };
  if (ch === '\x7f' || ch === '\b') return { kind: 'backspace' };
  if (ch === '\x17') return { kind: 'delete-word' }; // Ctrl+W
  if (ch === '\x04') return { kind: 'delete-forward' }; // Ctrl+D
  if (ch === '\x15' || ch === '\x03') return { kind: 'clear' }; // Ctrl+U, Ctrl+C
  if (ch === '\x01' || ch === '\x05' || ch === '\x02' || ch === '\x06') return { kind: 'move' };
  // Ctrl+J (Shift+Enter in agent terminals) is a newline inside the input.
  if (ch === '\n' || ch >= ' ') return { kind: 'insert', text: ch };
  // Tab, Ctrl+R, Ctrl+P/N, Ctrl+Y and the rest can rewrite the input.
  return { kind: 'unknown' };
}

/** A kitty-encoded key (`CSI code ; modifiers u`). */
function kittyKey(params: string): Key {
  const [code = Number.NaN, modifiers = 1] = params
    .split(';')
    .map((part) => Number.parseInt(part, 10));
  const plain = !modifiers || modifiers === 1;
  const ctrl = ((modifiers || 1) - 1) & 4;
  if (code === 13) return plain ? { kind: 'submit' } : { kind: 'insert', text: '\n' };
  if (code === 8 || code === 127) return { kind: 'backspace' };
  if (code === 27) return { kind: 'escape' };
  if (ctrl && code >= 97 && code <= 122) return plainKey(String.fromCharCode(code - 96));
  if (plain && code >= 32) return { kind: 'insert', text: String.fromCodePoint(code) };
  return { kind: 'unknown' };
}

/**
 * A CSI sequence's meaning as input: a key, the edges of a bracketed paste, or a report the
 * terminal sends on its own (null).
 */
function csiKey(params: string, intermediates: string, final: string): Key | null {
  // Focus in/out, cursor position, device status and attributes, mode and window reports.
  if (!params && (final === 'I' || final === 'O')) return null;
  if (final === 'R' || final === 'n' || final === 'c' || final === 't') return null;
  if (intermediates.includes('$') && final === 'y') return null;
  // SGR mouse reports.
  if (params.startsWith('<') && (final === 'M' || final === 'm')) return null;
  if (final === 'u') {
    // `CSI ? flags u` answers a keyboard-protocol query; the rest are kitty-encoded keys.
    return params.startsWith('?') ? null : kittyKey(params);
  }
  // Up and Down recall history; Shift+Tab cycles modes.
  if (final === 'A' || final === 'B' || final === 'Z') return { kind: 'unknown' };
  if (final === 'C' || final === 'D' || final === 'H' || final === 'F') return { kind: 'move' };
  if (final === '~') {
    const code = params.split(';')[0];
    if (code === '200') return { kind: 'paste-start' };
    if (code === '201') return { kind: 'paste-end' };
    if (code === '3') return { kind: 'delete-forward' };
    if (code === '1' || code === '4' || code === '7' || code === '8') return { kind: 'move' };
  }
  return { kind: 'other' };
}

/** Splits one chunk of terminal input into keys; the terminal's own reports are left out. */
function keysOf(data: string, inPaste: boolean): Key[] {
  const keys: Key[] = [];
  let pasting = inPaste;
  let index = 0;
  while (index < data.length) {
    const ch = data[index] as string;
    if (ch === '\x1b') {
      const next = data[index + 1];
      if (next === '[') {
        let end = index + 2;
        let params = '';
        let intermediates = '';
        while (end < data.length && /[0-?]/.test(data[end] as string)) params += data[end++];
        while (end < data.length && /[ -/]/.test(data[end] as string)) intermediates += data[end++];
        const final = data[end] ?? '';
        end += 1;
        // X10 mouse report: three raw bytes follow `CSI M`.
        const x10Mouse = !params && !intermediates && final === 'M';
        if (x10Mouse) end += 3;
        const key = x10Mouse ? null : csiKey(params, intermediates, final);
        if (key?.kind === 'paste-start') pasting = true;
        if (key?.kind === 'paste-end') pasting = false;
        if (key) keys.push(key);
        index = end;
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^') {
        // OSC, DCS, APC and PM strings are answers to the program (colors, capabilities).
        index = stringEnd(data, index + 2);
        continue;
      }
      if (next === 'O') {
        const final = data[index + 2];
        keys.push(
          final === 'A' || final === 'B'
            ? { kind: 'unknown' }
            : final === 'C' || final === 'D' || final === 'H' || final === 'F'
              ? { kind: 'move' }
              : { kind: 'other' }
        );
        index += 3;
        continue;
      }
      if (next === undefined || next === '\x1b') {
        keys.push({ kind: 'escape' });
        index += 1;
        continue;
      }
      // Alt with a key: Alt+Backspace deletes a word, Alt+B/F move by one; the rest can rewrite.
      keys.push(
        next === '\x7f' || next === '\b'
          ? { kind: 'delete-word' }
          : next === 'b' || next === 'f'
            ? { kind: 'move' }
            : { kind: 'unknown' }
      );
      index += 2;
      continue;
    }
    index += 1;
    keys.push(pasting ? { kind: 'insert', text: ch } : plainKey(ch));
  }
  return keys;
}

function recordFor(conversationId: string): TypingState {
  let record = records.get(conversationId);
  if (!record) {
    record = {
      lastKeystrokeAt: null,
      lastKeyWasSubmit: false,
      lastSubmitAt: null,
      draft: '',
      cursorMoved: false,
      dictated: false,
      unsentMessage: false,
      inPaste: false,
      lastEscapeAt: null,
    };
    records.set(conversationId, record);
  }
  return record;
}

/** The input is certainly empty now. */
function emptied(record: TypingState): void {
  record.draft = '';
  record.cursorMoved = false;
  record.dictated = false;
  record.unsentMessage = false;
}

/** The keys lost track of the input: it holds something, or nothing. */
function lostTrack(record: TypingState): void {
  record.draft = null;
  record.dictated = false;
  record.unsentMessage = false;
}

function applyKey(record: TypingState, key: Key, now: number): void {
  switch (key.kind) {
    case 'insert':
      if (record.draft !== null) record.draft += key.text;
      break;
    case 'backspace':
      if (record.draft !== null) record.draft = record.draft.slice(0, -1);
      break;
    case 'delete-forward':
      // At the end of the input it deletes nothing; elsewhere one character.
      if (record.draft !== null && record.cursorMoved) record.draft = record.draft.slice(0, -1);
      break;
    case 'delete-word':
      if (record.draft === null) break;
      if (record.cursorMoved) lostTrack(record);
      else record.draft = record.draft.replace(/\S*\s*$/, '');
      break;
    case 'submit':
      record.lastSubmitAt = now;
      emptied(record);
      break;
    case 'clear':
      emptied(record);
      break;
    case 'escape':
      // One Escape can close a menu or completion and change the input; two clear it.
      if (record.lastEscapeAt !== null && now - record.lastEscapeAt <= DOUBLE_ESCAPE_MS) {
        emptied(record);
      } else {
        lostTrack(record);
      }
      break;
    case 'move':
      record.cursorMoved = true;
      break;
    case 'unknown':
      lostTrack(record);
      break;
    case 'paste-start':
      record.inPaste = true;
      break;
    case 'paste-end':
      record.inPaste = false;
      break;
    case 'other':
      break;
  }
  record.lastEscapeAt = key.kind === 'escape' ? now : null;
}

/**
 * Records input the developer sent to a terminal through xterm. `sessionId` is the PTY session id
 * (an agent's is `<project>:<task>:<conversation>`). Input that holds only the terminal's own
 * reports is not a keystroke and changes nothing.
 */
export function noteDeveloperInput(sessionId: string, data: string, now = Date.now()): void {
  const conversationId = conversationOf(sessionId);
  const existing = records.get(conversationId);
  const keys = keysOf(data, existing?.inPaste ?? false);
  if (keys.length === 0) return;
  const record = existing ?? recordFor(conversationId);
  for (const key of keys) applyKey(record, key, now);
  record.lastKeystrokeAt = now;
  record.lastKeyWasSubmit = keys.at(-1)?.kind === 'submit';
}

/**
 * The conductor typed dictated words (the developer's own) into this conversation's input without
 * pressing Enter. Nothing else may be submitted with them. Not a keystroke.
 */
export function noteDictatedText(conversationId: string): void {
  recordFor(conversationId).dictated = true;
}

/**
 * A message the conductor pasted is still in this conversation's input, as far as it can tell:
 * the agent did not show that it took it. Nothing else may be submitted with it. Not a keystroke.
 */
export function noteUnsentMessage(conversationId: string): void {
  recordFor(conversationId).unsentMessage = true;
}

/**
 * The agent took the message `noteUnsentMessage` marked after all (it went on to finish a turn
 * or ask something). Clears only that mark; dictated words and typed text stay.
 */
export function clearUnsentMark(conversationId: string): void {
  const record = records.get(conversationId);
  if (record) record.unsentMessage = false;
}

/** The conductor pressed Enter in this conversation's input, submitting whatever was there. */
export function noteConductorSubmit(conversationId: string): void {
  const record = records.get(conversationId);
  if (record) emptied(record);
}

/** What the developer has typed into this conversation's terminal; null when nothing yet. */
export function developerTyping(conversationId: string): DeveloperTyping | null {
  const record = records.get(conversationId);
  if (!record) return null;
  const left = record.dictated || record.unsentMessage;
  const typed =
    record.draft === null
      ? 'unknown'
      : record.draft.trim().length >= DRAFT_MIN_CHARS
        ? 'text'
        : 'empty';
  return {
    lastKeystrokeAt: record.lastKeystrokeAt,
    lastKeyWasSubmit: record.lastKeyWasSubmit,
    lastSubmitAt: record.lastSubmitAt,
    draft: left ? 'text' : typed,
    unsentText: left || typed === 'text',
  };
}

/** When the developer last pressed a key in this conversation's terminal; null when never. */
export function lastDeveloperKeystroke(conversationId: string): number | null {
  return records.get(conversationId)?.lastKeystrokeAt ?? null;
}

/** Whether the developer pressed a key in this conversation's terminal after `since`. */
export function developerTypedSince(conversationId: string, since: number): boolean {
  const at = lastDeveloperKeystroke(conversationId);
  return at !== null && at > since;
}

/** Forgets a conversation's record (its session ended, so its input is gone). */
export function forgetDeveloperTyping(conversationId: string): void {
  records.delete(conversationId);
}

/** Forgets every record. For tests. */
export function resetDeveloperTyping(): void {
  records.clear();
}
