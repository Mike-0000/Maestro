import { describe, expect, it } from 'vitest';
import {
  describeSearch,
  describeWindow,
  searchText,
  searchTranscript,
  TRANSCRIPT_DEFAULT_LINES,
  transcriptLines,
  transcriptWindow,
  windowText,
} from './transcript';

const rows = (count: number) => Array.from({ length: count }, (_, index) => `row ${index + 1}`);

describe('transcriptLines', () => {
  it('splits a transcript into lines, and gives none for an empty one', () => {
    expect(transcriptLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(transcriptLines('')).toEqual([]);
    expect(transcriptLines(' \n ')).toEqual([]);
  });
});

describe('transcriptWindow', () => {
  it('gives a screenful of the latest lines when nothing is asked for', () => {
    const window = transcriptWindow(rows(500));
    expect(window).toMatchObject({ total: 500, first: 421, last: 500 });
    expect(window.lines).toHaveLength(TRANSCRIPT_DEFAULT_LINES);
    expect(window.lines[0]).toBe('row 421');
    expect(window.left).toBeUndefined();
    expect(describeWindow(window)).toBe(
      'Lines 421 to 500 of 500. Lines 1 to 420 are earlier: ask for more lines, or a range.'
    );
  });

  it('widens with each larger N: 50, then 100, then 200', () => {
    const lines = rows(1_000);
    for (const count of [50, 100, 200]) {
      const window = transcriptWindow(lines, { lines: count });
      expect(window).toMatchObject({ first: 1_000 - count + 1, last: 1_000 });
      expect(window.lines).toHaveLength(count);
    }
  });

  it('has no limit on N: a large N reads every line there is', () => {
    const lines = rows(15_000);
    const window = transcriptWindow(lines, { lines: 12_000 });
    expect(window).toMatchObject({ first: 3_001, last: 15_000 });
    expect(window.lines).toHaveLength(12_000);
    expect(window.left).toBeUndefined();

    const more = transcriptWindow(lines, { lines: 1_000_000_000 });
    expect(more).toMatchObject({ first: 1, last: 15_000 });
    expect(more.lines).toHaveLength(15_000);
    expect(describeWindow(more)).toBe('Lines 1 to 15000 of 15000.');
  });

  it('reads a range from X to Y, both inclusive', () => {
    const window = transcriptWindow(rows(100), { from: 10, to: 12 });
    expect(window).toMatchObject({ first: 10, last: 12 });
    expect(windowText(window)).toBe('10: row 10\n11: row 11\n12: row 12');
    expect(transcriptWindow(rows(100), { from: 7, to: 7 }).lines).toEqual(['row 7']);
    expect(describeWindow(transcriptWindow(rows(100), { from: 7, to: 7 }))).toContain('Line 7 of');
  });

  it('counts lines from a start or back from an end', () => {
    expect(transcriptWindow(rows(100), { from: 20, lines: 5 })).toMatchObject({
      first: 20,
      last: 24,
    });
    expect(transcriptWindow(rows(100), { to: 30, lines: 5 })).toMatchObject({
      first: 26,
      last: 30,
    });
    expect(transcriptWindow(rows(100), { from: 95 })).toMatchObject({ first: 95, last: 100 });
    expect(transcriptWindow(rows(100), { to: 3 })).toMatchObject({ first: 1, last: 3 });
  });

  it('clamps a range that runs past the end of the transcript', () => {
    const window = transcriptWindow(rows(100), { from: 90, to: 500 });
    expect(window).toMatchObject({ total: 100, first: 90, last: 100 });
    expect(window.lines).toHaveLength(11);
    expect(window.left).toBeUndefined();
  });

  it('clamps a range that reaches back past the start of the transcript', () => {
    const window = transcriptWindow(rows(100), { to: 5, lines: 50 });
    expect(window).toMatchObject({ first: 1, last: 5 });
    expect(window.lines).toEqual(['row 1', 'row 2', 'row 3', 'row 4', 'row 5']);
    expect(describeWindow(window)).toBe('Lines 1 to 5 of 100.');
  });

  it('shows nothing, and says how long the transcript is, for a range wholly past the end', () => {
    const window = transcriptWindow(rows(100), { from: 200, to: 300 });
    expect(window).toMatchObject({ total: 100, first: 0, last: 0, lines: [] });
    expect(describeWindow(window)).toBe(
      'The transcript has 100 lines, so nothing starts at line 200. Its last line is 100.'
    );
    expect(windowText(window)).toBe('');
  });

  it('says so when a range ends before it starts, or the transcript is empty', () => {
    expect(describeWindow(transcriptWindow(rows(100), { from: 30, to: 10 }))).toBe(
      'Line 30 comes after line 10, so there is no range to read.'
    );
    expect(describeWindow(transcriptWindow([], { lines: 50 }))).toBe('The transcript is empty.');
    expect(describeWindow(transcriptWindow(['only'], { from: 3 }))).toContain('has 1 line,');
  });

  it('keeps the newest lines of a tail too large for one result, and names what is left', () => {
    // Each line is 10 characters and a line break: 100 characters hold 9 of them.
    const lines = Array.from({ length: 50 }, (_, index) => `line ${String(index + 1).padStart(5)}`);
    const window = transcriptWindow(lines, { lines: 40 }, 100);
    expect(window).toMatchObject({ first: 42, last: 50, left: { first: 11, last: 41 } });
    expect(describeWindow(window)).toBe(
      'Lines 42 to 50 of 50. Lines 11 to 41 did not fit in one result: read them with from and to.'
    );
    // Reading what is left, part by part, reaches every line that was asked for.
    const next = transcriptWindow(lines, { from: 11, to: 41 }, 100);
    expect(next).toMatchObject({ first: 11, last: 19, left: { first: 20, last: 41 } });
  });

  it('always shows at least one line, however long it is', () => {
    const window = transcriptWindow(['x'.repeat(500), 'y'.repeat(500)], { lines: 2 }, 100);
    expect(window).toMatchObject({ first: 2, last: 2, left: { first: 1, last: 1 } });
  });
});

describe('searchTranscript', () => {
  const chat = [
    'Developer: add a retry to the upload',
    'Agent: reading upload.ts',
    'tool output',
    'tool output',
    'Agent: the Upload fails on a 503',
    'tool output',
    'tool output',
    'tool output',
    'tool output',
    'Agent: added a retry with backoff',
    'Agent: tests pass',
  ];

  it('finds a string whatever its case and shows the lines around each match', () => {
    const search = searchTranscript(chat, { query: 'UPLOAD', context: 1 });
    expect(search.found).toEqual([1, 2, 5]);
    expect(search.shown).toEqual([1, 2, 5]);
    expect(searchText(search)).toBe(
      [
        '> 1: Developer: add a retry to the upload',
        '> 2: Agent: reading upload.ts',
        '  3: tool output',
        '  4: tool output',
        '> 5: Agent: the Upload fails on a 503',
        '  6: tool output',
      ].join('\n')
    );
    expect(describeSearch(search, 'UPLOAD')).toBe(
      '3 lines hold "UPLOAD", of 11 lines. Matching lines start with ">".'
    );
  });

  it('separates matches that are far apart, and clamps context at both ends', () => {
    const search = searchTranscript(chat, { query: 'retry', context: 2 });
    expect(search.found).toEqual([1, 10]);
    expect(search.blocks.map((block) => [block.first, block.lines.length])).toEqual([
      [1, 3],
      [8, 4],
    ]);
    expect(searchText(search)).toContain('  3: tool output\n  …\n  8: tool output');
    expect(searchText(search).endsWith('  11: Agent: tests pass')).toBe(true);
  });

  it('shows only the matching lines with no context', () => {
    const search = searchTranscript(chat, { query: 'agent:', context: 0 });
    expect(search.found).toEqual([2, 5, 10, 11]);
    expect(search.blocks.map((block) => block.lines.length)).toEqual([1, 1, 2]);
  });

  it('says when nothing matches, and when the transcript is empty', () => {
    const none = searchTranscript(chat, { query: 'database' });
    expect(none.found).toEqual([]);
    expect(searchText(none)).toBe('');
    expect(describeSearch(none, 'database')).toContain('No line of the 11 lines holds "database".');
    expect(describeSearch(searchTranscript([], { query: 'x' }), 'x')).toBe(
      'The transcript is empty.'
    );
  });

  it('shows the newest matches when there are more than asked for, and lists the rest', () => {
    const lines = rows(1_000).map((row, index) => (index % 10 === 0 ? `${row} needle` : row));
    const search = searchTranscript(lines, { query: 'needle', context: 0, matches: 3 });
    expect(search.found).toHaveLength(100);
    expect(search.shown).toEqual([971, 981, 991]);
    const about = describeSearch(search, 'needle');
    expect(about).toContain('100 lines hold "needle", of 1000 lines.');
    expect(about).toContain('The newest 3 are shown. Earlier matches are at lines 1, 11, 21,');
    expect(about).toContain('951, 961: read around one with read_chat');

    // No limit on how many matches may be asked for.
    const all = searchTranscript(lines, { query: 'needle', context: 0, matches: 100_000 });
    expect(all.shown).toHaveLength(100);
  });

  it('shows fewer matches when they would not fit in one result', () => {
    const lines = Array.from({ length: 40 }, () => 'needle 123');
    const search = searchTranscript(lines, { query: 'needle', context: 0, matches: 40 }, 55);
    expect(search.found).toHaveLength(40);
    expect(search.shown).toEqual([36, 37, 38, 39, 40]);
  });
});
