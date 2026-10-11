import type { ILink } from '@xterm/xterm';

// Lookbehind on `:` keeps URLs (`https://...`) with WebLinksAddon.
const FILE_PATH_PATTERN =
  '(?<![\\w\\-./@:])(~/|/|\\.{1,2}/)?(?:[\\w\\-.@]+/)+[\\w\\-.@]+\\.[a-zA-Z][a-zA-Z0-9]{0,9}\\b';
// A Markdown file in any spelling: Windows separators and drive letters, and a bare file name.
// The general pattern needs a forward slash, which an agent on Windows often does not print.
// Folder names may hold letters of any script and, after the first, an apostrophe (a Windows
// user folder such as `'admin'`); a quote in front of the path is not part of it.
const SEPARATOR = String.raw`[\\/]`;
const NAME_START = String.raw`[\p{L}\p{N}_\-.@]`;
const NAME_CHAR = String.raw`[\p{L}\p{N}_\-.@']`;
const MARKDOWN_PATH_PATTERN =
  String.raw`(?<![\p{L}\p{N}_\-./\\@:~])` +
  `(?:(?:[a-z]:${SEPARATOR}|~${SEPARATOR}|\\.{1,2}${SEPARATOR}|${SEPARATOR})${NAME_CHAR}+|${NAME_START}${NAME_CHAR}*)` +
  `(?:${SEPARATOR}${NAME_CHAR}+)*` +
  String.raw`\.(?:md|mdx|markdown)(?![\p{L}\p{N}_\-@\\/]|\.[\p{L}\p{N}_])`;
/** What may come right before a path that starts with a separator. */
const BEFORE_ROOTED_PATH = /[\s([{"'`<=]/;
/** A drive path cut short by a space: the words after it are the rest of that path, not a file. */
const SPACED_DRIVE_PATH_BEFORE = /(?:^|\s)[a-z]:[\\/]\S* $/i;
const URL_PROTOCOL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const MAX_WRAPPED_LINE_LENGTH = 4096;

export type BufferLineLike = {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
};

export type BufferLike = {
  getLine(index: number): BufferLineLike | undefined;
};

export type FileLinkMatch = {
  range: ILink['range'];
  text: string;
  isExternal: boolean;
};

type LogicalLine = {
  startBufferIndex: number;
  lineTexts: string[];
  lineStartColumns: number[];
  text: string;
};

type PathSpan = { text: string; start: number; end: number };

/** Which separators join a path across a hard line break. */
type PathDialect = 'posix' | 'any';

export function findFileLinks(buffer: BufferLike, bufferLineNumber: number): FileLinkMatch[] {
  // The general pattern reads the line exactly as before. Markdown paths read it again with
  // backslash paths joined across hard line breaks too.
  const general = linksOn(
    getWrappedLogicalLine(buffer, bufferLineNumber - 1, 'posix'),
    bufferLineNumber,
    (text) => (text.indexOf('/') === -1 ? [] : findPathSpans(text, FILE_PATH_PATTERN, 'g'))
  );
  const markdown = linksOn(
    getWrappedLogicalLine(buffer, bufferLineNumber - 1, 'any'),
    bufferLineNumber,
    findMarkdownSpans
  );
  // A Markdown path wins where the two overlap: it is the whole path, where the general pattern
  // may have caught only the part after a backslash.
  return [
    ...markdown,
    ...general.filter((link) => !markdown.some((other) => rangesOverlap(link.range, other.range))),
  ].sort((a, b) => comparePositions(a.range.start, b.range.start));
}

function findMarkdownSpans(text: string): PathSpan[] {
  return findPathSpans(text, MARKDOWN_PATH_PATTERN, 'giu').filter((span) => {
    const before = text.slice(0, span.start);
    // A separator earlier in the same word: this is the tail of a path with a folder name the
    // pattern cannot read, and half a path is worse than no link.
    if (/[\\/]\S*$/.test(before)) return false;
    if (/^[\\/]/.test(span.text)) return before === '' || BEFORE_ROOTED_PATH.test(before.slice(-1));
    return /^[a-z]:[\\/]/i.test(span.text) || !SPACED_DRIVE_PATH_BEFORE.test(before);
  });
}

function comparePositions(a: ILink['range']['start'], b: ILink['range']['start']): number {
  return a.y === b.y ? a.x - b.x : a.y - b.y;
}

function rangesOverlap(a: ILink['range'], b: ILink['range']): boolean {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0;
}

function linksOn(
  logicalLine: LogicalLine | null,
  bufferLineNumber: number,
  findSpans: (text: string) => PathSpan[]
): FileLinkMatch[] {
  if (!logicalLine || !logicalLine.text) return [];
  const links: FileLinkMatch[] = [];
  for (const span of findSpans(logicalLine.text)) {
    const matched = span.text;
    const startOffset = span.start;
    const endOffset = span.end;
    const range = mapOffsetRangeToBufferRange(logicalLine, startOffset, endOffset);
    if (!range) continue;

    const visibleRanges = mapOffsetRangeToVisibleBufferRanges(logicalLine, startOffset, endOffset);
    const linkRanges = shouldUseVisibleRanges(visibleRanges) ? visibleRanges : [range];
    for (const linkRange of linkRanges) {
      if (!rangeContainsBufferLine(linkRange, bufferLineNumber)) continue;
      links.push({
        range: linkRange,
        text: matched,
        isExternal: matched.startsWith('~/') || matched.startsWith('/'),
      });
    }
  }
  return links;
}

function findPathSpans(text: string, pattern: string, flags: string): PathSpan[] {
  const spans: PathSpan[] = [];
  // Fresh regex per call — module-level /g state isn't safe across reentrancy.
  const regex = new RegExp(pattern, flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (isEmbeddedInUrl(text, match.index)) continue;
    spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function isEmbeddedInUrl(text: string, startCol: number): boolean {
  const prefix = text.slice(0, startCol);
  const tokenStart = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\t'), -1) + 1;
  return URL_PROTOCOL_PATTERN.test(prefix.slice(tokenStart));
}

function getWrappedLogicalLine(
  buffer: BufferLike,
  bufferIndex: number,
  dialect: PathDialect
): LogicalLine | null {
  const line = buffer.getLine(bufferIndex);
  if (!line) return null;

  let startBufferIndex = bufferIndex;
  while (startBufferIndex > 0 && buffer.getLine(startBufferIndex)?.isWrapped) {
    startBufferIndex -= 1;
  }

  const lineTexts: string[] = [];
  const lineStartColumns: number[] = [];
  let currentIndex = startBufferIndex;
  let totalLength = 0;
  while (true) {
    const currentLine = buffer.getLine(currentIndex);
    if (!currentLine) break;

    const text = currentLine.translateToString(true);
    lineTexts.push(text);
    lineStartColumns.push(0);
    totalLength += text.length;
    if (totalLength > MAX_WRAPPED_LINE_LENGTH) return null;

    const nextLine = buffer.getLine(currentIndex + 1);
    if (!nextLine?.isWrapped) break;
    currentIndex += 1;
  }

  return expandHardLineBreakPathContinuations(
    buffer,
    {
      startBufferIndex,
      lineTexts,
      lineStartColumns,
      text: lineTexts.join(''),
    },
    dialect
  );
}

function expandHardLineBreakPathContinuations(
  buffer: BufferLike,
  logicalLine: LogicalLine,
  dialect: PathDialect
): LogicalLine {
  let expanded = logicalLine;
  const firstLine = expanded.lineTexts[0];
  const previousBufferLine = buffer.getLine(expanded.startBufferIndex - 1);
  const previousLine = previousBufferLine?.isWrapped
    ? undefined
    : previousBufferLine?.translateToString(true);
  if (
    firstLine !== undefined &&
    previousLine !== undefined &&
    endsWithPathContinuation(previousLine, dialect) &&
    startsWithPathContinuation(firstLine, dialect)
  ) {
    expanded = {
      startBufferIndex: expanded.startBufferIndex - 1,
      lineTexts: [
        previousLine,
        trimPathContinuationStart(firstLine),
        ...expanded.lineTexts.slice(1),
      ],
      lineStartColumns: [
        0,
        countLeadingWhitespace(firstLine),
        ...expanded.lineStartColumns.slice(1),
      ],
      text: '',
    };
    expanded.text = expanded.lineTexts.join('');
  }

  const lastLineIndex = expanded.startBufferIndex + expanded.lineTexts.length - 1;
  const nextLine = buffer.getLine(lastLineIndex + 1)?.translateToString(true);
  if (
    nextLine !== undefined &&
    endsWithPathContinuation(expanded.text, dialect) &&
    startsWithPathContinuation(nextLine, dialect)
  ) {
    const trimmedNextLine = trimPathContinuationStart(nextLine);
    expanded = {
      startBufferIndex: expanded.startBufferIndex,
      lineTexts: [...expanded.lineTexts, trimmedNextLine],
      lineStartColumns: [...expanded.lineStartColumns, countLeadingWhitespace(nextLine)],
      text: expanded.text + trimmedNextLine,
    };
  }

  return expanded.text.length > MAX_WRAPPED_LINE_LENGTH ? logicalLine : expanded;
}

function endsWithPathContinuation(text: string, dialect: PathDialect): boolean {
  const fragment = trailingToken(text);
  const pathLike = fragment.includes('/') || (dialect === 'any' && fragment.includes('\\'));
  return pathLike && !isEmbeddedInUrl(text, text.length - fragment.length);
}

function startsWithPathContinuation(text: string, dialect: PathDialect): boolean {
  const trimmed = trimPathContinuationStart(text);
  return dialect === 'any'
    ? /^[\p{L}\p{N}_.\-@']+(?:[\\/]|\.[a-zA-Z][a-zA-Z0-9]{0,9}\b)/u.test(trimmed)
    : /^[\w.\-@]+(?:\/|[\w.\-@]*\.[a-zA-Z][a-zA-Z0-9]{0,9}\b)/.test(trimmed);
}

function trimPathContinuationStart(text: string): string {
  return text.slice(countLeadingWhitespace(text));
}

function countLeadingWhitespace(text: string): number {
  return text.length - text.trimStart().length;
}

function trailingToken(text: string): string {
  const match = /[^\s([{"'`<]+$/.exec(text);
  return match?.[0] ?? '';
}

function mapOffsetRangeToBufferRange(
  logicalLine: LogicalLine,
  startOffset: number,
  endOffset: number
): ILink['range'] | null {
  const start = mapOffsetToBufferPosition(logicalLine, startOffset);
  const end = mapOffsetToBufferPosition(logicalLine, endOffset - 1);
  if (!start || !end) return null;
  return { start, end };
}

function mapOffsetRangeToVisibleBufferRanges(
  logicalLine: LogicalLine,
  startOffset: number,
  endOffset: number
): ILink['range'][] {
  const ranges: ILink['range'][] = [];
  let lineStartOffset = 0;
  for (let lineIndex = 0; lineIndex < logicalLine.lineTexts.length; lineIndex += 1) {
    const lineLength = logicalLine.lineTexts[lineIndex]?.length ?? 0;
    const lineEndOffset = lineStartOffset + lineLength;
    const segmentStartOffset = Math.max(startOffset, lineStartOffset);
    const segmentEndOffset = Math.min(endOffset, lineEndOffset);
    if (segmentStartOffset < segmentEndOffset) {
      const xOffset = logicalLine.lineStartColumns[lineIndex] ?? 0;
      const y = logicalLine.startBufferIndex + lineIndex + 1;
      ranges.push({
        start: {
          x: xOffset + segmentStartOffset - lineStartOffset + 1,
          y,
        },
        end: {
          x: xOffset + segmentEndOffset - lineStartOffset,
          y,
        },
      });
    }
    lineStartOffset = lineEndOffset;
  }
  return ranges;
}

function shouldUseVisibleRanges(ranges: ILink['range'][]): boolean {
  return ranges.some((range, index) => index > 0 && range.start.x > 1);
}

function rangeContainsBufferLine(range: ILink['range'], bufferLineNumber: number): boolean {
  return range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber;
}

function mapOffsetToBufferPosition(
  logicalLine: LogicalLine,
  offset: number
): ILink['range']['start'] | null {
  let remaining = offset;
  for (let lineIndex = 0; lineIndex < logicalLine.lineTexts.length; lineIndex += 1) {
    const lineLength = logicalLine.lineTexts[lineIndex]?.length ?? 0;
    if (remaining < lineLength) {
      return {
        x: (logicalLine.lineStartColumns[lineIndex] ?? 0) + remaining + 1,
        y: logicalLine.startBufferIndex + lineIndex + 1,
      };
    }
    remaining -= lineLength;
  }
  return null;
}
