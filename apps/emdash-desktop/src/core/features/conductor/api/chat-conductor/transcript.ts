/**
 * Reading a chat's transcript by line: a window of it (`read_chat`), or the lines that hold a
 * string (`search_chat`). Lines are numbered from 1 at the oldest line that can be read, the same
 * way in both, so a search hit can be opened with a window around its number.
 *
 * Neither puts a limit on how much is read: a window gives every line asked for, and a search
 * shows every match asked for, however large the result.
 */

/** Lines a read gives when none are asked for: about a screenful. */
export const TRANSCRIPT_DEFAULT_LINES = 80;
export const SEARCH_DEFAULT_CONTEXT = 3;
export const SEARCH_DEFAULT_MATCHES = 20;

export type TranscriptWindowInput = {
  /** How many lines: the last ones, or counted from `from`, or up to `to`. */
  readonly lines?: number;
  /** First line, counted from 1. */
  readonly from?: number;
  /** Last line, inclusive. */
  readonly to?: number;
};

export type TranscriptWindow = {
  /** Lines the transcript has now. */
  readonly total: number;
  /** First and last line shown, counted from 1; both 0 when nothing is shown. */
  readonly first: number;
  readonly last: number;
  readonly lines: readonly string[];
  /** Why nothing is shown, when the window lies outside the transcript. */
  readonly note?: string;
};

/** A transcript as lines; one with nothing in it has none. */
export function transcriptLines(text: string): string[] {
  return text.trim() === '' ? [] : text.split('\n');
}

function count(total: number): string {
  return total === 1 ? '1 line' : `${total} lines`;
}

/**
 * The window of `lines` that was asked for. With neither `from` nor `to` it is the end of the
 * transcript; a range is clamped to the lines there are, and one that lies wholly outside them
 * shows nothing and says how long the transcript is.
 */
export function transcriptWindow(
  lines: readonly string[],
  input: TranscriptWindowInput = {}
): TranscriptWindow {
  const total = lines.length;
  const nothing = (note: string): TranscriptWindow => ({
    total,
    first: 0,
    last: 0,
    lines: [],
    note,
  });
  if (total === 0) return nothing('The transcript is empty.');
  const tail = input.from === undefined && input.to === undefined;
  let first: number;
  let last: number;
  if (tail) {
    last = total;
    first = total - (input.lines ?? TRANSCRIPT_DEFAULT_LINES) + 1;
  } else if (input.from !== undefined) {
    first = input.from;
    last = input.to ?? (input.lines === undefined ? total : input.from + input.lines - 1);
  } else {
    last = input.to ?? total;
    first = input.lines === undefined ? 1 : last - input.lines + 1;
  }
  if (first > total) {
    return nothing(
      `The transcript has ${count(total)}, so nothing starts at line ${first}. Its last line is ${total}.`
    );
  }
  if (first > last) {
    return nothing(`Line ${first} comes after line ${last}, so there is no range to read.`);
  }
  if (last < 1) return nothing(`The transcript starts at line 1. It has ${count(total)}.`);
  first = Math.max(1, first);
  last = Math.min(total, last);
  return { total, first, last, lines: lines.slice(first - 1, last) };
}

function numbered(lines: readonly string[], first: number, mark?: ReadonlySet<number>): string[] {
  return lines.map((line, index) => {
    const number = first + index;
    return `${mark ? (mark.has(number) ? '> ' : '  ') : ''}${number}: ${line}`;
  });
}

/** What a window says about itself, above its lines. */
export function describeWindow(window: TranscriptWindow): string {
  if (window.lines.length === 0) return window.note ?? 'There is nothing to read.';
  const shown =
    window.first === window.last
      ? `Line ${window.first}`
      : `Lines ${window.first} to ${window.last}`;
  const parts = [`${shown} of ${window.total}.`];
  if (window.first > 1) {
    parts.push(`Lines 1 to ${window.first - 1} are earlier: ask for more lines, or a range.`);
  }
  return parts.join(' ');
}

/** A window's lines, each under its number. */
export function windowText(window: TranscriptWindow): string {
  return numbered(window.lines, window.first).join('\n');
}

export type TranscriptSearchInput = {
  readonly query: string;
  /** Lines shown before and after each match. */
  readonly context?: number;
  /** How many matches to show, newest first in the choosing. */
  readonly matches?: number;
};

export type TranscriptSearch = {
  readonly total: number;
  /** Every line that holds the string, counted from 1. */
  readonly found: readonly number[];
  /** The matches shown: the newest ones, in transcript order. */
  readonly shown: readonly number[];
  /** Runs of lines around the shown matches; runs that touch are one. */
  readonly blocks: readonly { readonly first: number; readonly lines: readonly string[] }[];
};

/**
 * The lines that hold `query`, compared without regard to case, with the lines around them. The
 * newest matches are shown when there are more than asked for; `found` always holds every match,
 * so an older one can be read by number.
 */
export function searchTranscript(
  lines: readonly string[],
  input: TranscriptSearchInput
): TranscriptSearch {
  const total = lines.length;
  const needle = input.query.trim().toLowerCase();
  const context = Math.max(0, input.context ?? SEARCH_DEFAULT_CONTEXT);
  const wanted = Math.max(1, input.matches ?? SEARCH_DEFAULT_MATCHES);
  const found: number[] = [];
  if (needle) {
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) found.push(index + 1);
    });
  }
  // The newest matches, as many as were asked for.
  const shown = found.slice(Math.max(0, found.length - wanted));
  const blocks: { first: number; last: number }[] = [];
  for (const match of shown) {
    const first = Math.max(1, match - context);
    const last = Math.min(total, match + context);
    const previous = blocks[blocks.length - 1];
    if (previous && first <= previous.last + 1) previous.last = Math.max(previous.last, last);
    else blocks.push({ first, last });
  }
  return {
    total,
    found,
    shown,
    blocks: blocks.map((block) => ({
      first: block.first,
      lines: lines.slice(block.first - 1, block.last),
    })),
  };
}

/** Line numbers listed for the matches not shown; more than this many are counted instead. */
const OTHER_MATCHES_LISTED = 200;

/** What a search says about itself, above its matches. */
export function describeSearch(search: TranscriptSearch, query: string): string {
  const said = `"${query.trim().replace(/"/g, "'")}"`;
  if (search.total === 0) return 'The transcript is empty.';
  if (search.found.length === 0) {
    return `No line of the ${count(search.total)} holds ${said}. The search ignores case and matches the string as written, so try a shorter or different one.`;
  }
  const matches = search.found.length === 1 ? '1 line holds' : `${search.found.length} lines hold`;
  const parts = [`${matches} ${said}, of ${count(search.total)}.`];
  if (search.shown.length < search.found.length) {
    const others = search.found.slice(0, search.found.length - search.shown.length);
    const listed = others.slice(-OTHER_MATCHES_LISTED);
    parts.push(
      `The newest ${search.shown.length} are shown. Earlier matches are at ${
        listed.length < others.length ? `${others.length} lines, the latest of them ` : 'lines '
      }${listed.join(', ')}: read around one with read_chat, or ask for more matches.`
    );
  }
  parts.push('Matching lines start with ">".');
  return parts.join(' ');
}

/** The matches with their surrounding lines, each line under its number. */
export function searchText(search: TranscriptSearch): string {
  const marks = new Set(search.found);
  return search.blocks
    .map((block) => numbered(block.lines, block.first, marks).join('\n'))
    .join('\n  …\n');
}
