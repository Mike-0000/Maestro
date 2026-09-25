/**
 * Short, speakable synopses of what an agent just finished ("Kilo researched TTS models across
 * three areas: naturalness, latency, and multilingual support.").
 *
 * The source of truth is the agent's own final reply as reported by its Stop hook
 * (`lastAssistantMessage`) — never raw terminal output — with the task name as a fallback. The
 * result is deliberately small: code, URLs, e-mail addresses, and token-like strings are dropped,
 * paths shrink to their basename, and the phrase is capped at a few words so it reads well aloud
 * and in an OS notification. Everything here is pure and deterministic (no model call), so a
 * summary is available the moment the completion event arrives.
 */

export const COMPLETION_SUMMARY_MAX_WORDS = 16;
export const COMPLETION_SUMMARY_MAX_CHARS = 120;
/** Only the start of a long final reply is considered; the synopsis lives there. */
const MAX_INPUT_CHARS = 4_000;
/** A colon-terminated lead-in may absorb this many short list items ("…: a, b, and c"). */
const MAX_LIST_ITEMS = 3;
const MAX_LIST_ITEM_WORDS = 4;

const TRAILING_FILLER = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'including',
  'into',
  'of',
  'on',
  'or',
  'so',
  'such',
  'that',
  'the',
  'to',
  'which',
  'with',
  'while',
]);

/** Words that say nothing about *what* was done. */
const GENERIC_WORDS = new Set([
  ...TRAILING_FILLER,
  'all',
  'am',
  'are',
  'be',
  'been',
  'changes',
  'change',
  'complete',
  'completed',
  'done',
  'everything',
  'finished',
  'good',
  'have',
  'has',
  'here',
  'i',
  "i've",
  'is',
  'it',
  'let',
  'me',
  'my',
  'now',
  'ready',
  'request',
  'requested',
  'set',
  'successfully',
  'summary',
  'task',
  'this',
  'up',
  'was',
  'we',
  'were',
  'what',
  'work',
  'you',
  'your',
]);

/** Past-tense-looking words that usually are not the verb of a summary sentence. */
const NOT_A_VERB = new Set([
  'based',
  'called',
  'detailed',
  'embedded',
  'expected',
  'limited',
  'named',
  'need',
  'related',
  'required',
  'seed',
  'speed',
  'unexpected',
]);

const IRREGULAR_PAST = new Set([
  'built',
  'did',
  'drew',
  'found',
  'got',
  'kept',
  'made',
  'put',
  'ran',
  'read',
  'rebuilt',
  'reran',
  'rewrote',
  'set',
  'split',
  'took',
  'wrote',
]);

/** Common task-name verbs, used to phrase "finished researching …" from a task title. */
const TASK_VERBS = new Set([
  'add',
  'analyse',
  'analyze',
  'archive',
  'audit',
  'benchmark',
  'build',
  'bump',
  'check',
  'clean',
  'compare',
  'configure',
  'convert',
  'create',
  'debug',
  'delete',
  'deploy',
  'design',
  'diagnose',
  'document',
  'draft',
  'enable',
  'disable',
  'evaluate',
  'explore',
  'expose',
  'extract',
  'fetch',
  'find',
  'fix',
  'generate',
  'handle',
  'harden',
  'implement',
  'improve',
  'integrate',
  'investigate',
  'localize',
  'make',
  'measure',
  'migrate',
  'move',
  'optimize',
  'outline',
  'patch',
  'plan',
  'polish',
  'port',
  'profile',
  'prototype',
  'refactor',
  'remove',
  'rename',
  'replace',
  'reproduce',
  'research',
  'resolve',
  'restore',
  'review',
  'rewrite',
  'run',
  'scaffold',
  'secure',
  'set',
  'ship',
  'simplify',
  'split',
  'study',
  'summarize',
  'support',
  'sync',
  'test',
  'tidy',
  'trace',
  'track',
  'translate',
  'triage',
  'update',
  'upgrade',
  'validate',
  'verify',
  'wire',
  'write',
]);

/** Verbs whose final consonant doubles before "-ing". */
const DOUBLING_VERBS = new Set(['debug', 'plan', 'run', 'set', 'ship', 'split', 'stop', 'wrap']);

/** Openers that carry no content ("Done!", "All set.", "Here's what I did:"). */
const FILLER_SENTENCE =
  /^(?:(?:all\s+)?done|finished|complete[d]?|great|perfect|excellent|ok(?:ay)?|sure|success|all\s+set|got\s+it|summary|tl;?dr)\b[\s!.,:;-]*$/i;
const HERE_IS_LEAD_IN = /^(?:here(?:'s|\s+is|\s+are)|below\s+is|this\s+is)\b.*:$/i;
const LEADING_FILLER =
  /^(?:(?:all\s+)?done|finished|complete[d]?|great|perfect|summary|tl;?dr)\s*(?:[-—–:!,.]+\s*)+/i;
const LEADING_PRONOUN = /^(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+/i;
const LEADING_ADVERB = /^(?:also|just|now|successfully|finally|first)\s+/i;

/**
 * Condenses an agent's final reply into a few words describing what it did, or null when the
 * reply is missing or says nothing specific ("Done!").
 */
export function summarizeCompletionMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const lines = cleanMarkdown(message.slice(0, MAX_INPUT_CHARS));
  // Prose first; list items only when the prose is all lead-ins ("Here's what I did:").
  return summarizeLines(lines, 'text') ?? summarizeLines(lines, 'item');
}

function summarizeLines(lines: CleanLine[], kind: CleanLine['kind']): string | null {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind !== kind) continue;
    for (const raw of splitSentences(line.text)) {
      if (raw.endsWith('?')) continue;
      let sentence = stripLeadIns(raw);
      if (!sentence || FILLER_SENTENCE.test(sentence) || HERE_IS_LEAD_IN.test(sentence)) continue;
      if (sentence.endsWith(':')) {
        const items = listItemsAfter(lines, index);
        sentence = items.length > 0 ? `${sentence} ${joinList(items)}` : sentence.slice(0, -1);
      }
      const phrase = clamp(sentence);
      if (phrase && !isGeneric(phrase)) return phrase;
    }
  }
  return null;
}

/** A readable phrase from a task name; turns branch-style slugs back into words. */
export function taskNamePhrase(taskName: string | null | undefined): string | null {
  if (!taskName) return null;
  let text = sanitize(taskName).trim();
  if (!/\s/.test(text) && /[-_]/.test(text)) {
    const parts = text.split(/[-_]+/).filter(Boolean);
    // Generated slugs end in a short random suffix ("…-dpcfs"); drop it.
    const last = parts.at(-1);
    if (parts.length > 2 && last && isRandomSuffix(last)) parts.pop();
    text = parts.join(' ');
  }
  const phrase = clamp(text);
  return phrase && !isGeneric(phrase) ? phrase : null;
}

/**
 * One spoken/visible sentence for a finished agent. Prefers the reply synopsis, then the task,
 * then the generic "is done" so completion is always announced.
 */
export function completionSentence(
  agentName: string,
  summary: string | null | undefined,
  taskName?: string | null
): string {
  if (summary) {
    const [first = '', ...rest] = summary.split(' ');
    if (isPastTenseVerb(first) && rest.length > 0) {
      return `${agentName} ${first.toLowerCase()} ${rest.join(' ')}.`;
    }
    return `${agentName} finished: ${summary}.`.replace(/\s+\./, '.');
  }
  const task = taskNamePhrase(taskName);
  if (task) {
    const [first = '', ...rest] = task.split(' ');
    const lower = first.toLowerCase();
    if (TASK_VERBS.has(lower) && rest.length > 0) {
      return `${agentName} finished ${gerund(lower)} ${rest.join(' ')}.`;
    }
    return `${agentName} finished: ${task}.`;
  }
  return `${agentName} is done.`;
}

/** Notification body for a completion: the synopsis as a sentence, or null to keep the default. */
export function completionNotificationBody(summary: string | null | undefined): string | null {
  if (!summary) return null;
  return `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`;
}

// ── Internals ────────────────────────────────────────────────────────────────

type CleanLine = { kind: 'text' | 'item'; text: string };

function cleanMarkdown(message: string): CleanLine[] {
  const withoutCode = message
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n');
  const lines: CleanLine[] = [];
  for (const rawLine of withoutCode.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(?:[-*_]\s*){3,}$/.test(line)) continue;
    if (line.startsWith('|') || line.startsWith('>')) continue;
    const item = /^(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) line = item[1]!;
    const text = sanitize(line).trim();
    if (text) lines.push({ kind: item ? 'item' : 'text', text });
  }
  // Replies that are nothing but a list: treat the first item as the synopsis.
  if (!lines.some((line) => line.kind === 'text') && lines[0]) lines[0].kind = 'text';
  return lines;
}

/** Removes markdown syntax and anything that should not be shown or spoken. */
function sanitize(text: string): string {
  return (
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, (_, code: string) => (code.length <= 30 ? code : ''))
      .replace(/<[^>]+>/g, '')
      .replace(/\b(?:https?|ftp|file|ssh):\/\/\S+/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\S+@\S+\.\S+/g, '')
      .replace(
        /\b[\w.-]*(?:token|secret|password|passwd|api[_-]?key|auth)[\w.-]*\s*[=:]\s*['"]?[\w+/.=-]{12,}['"]?/gi,
        ''
      )
      // Paths shrink to their basename; "and/or" style pairs are left alone.
      .replace(/(?:[A-Za-z]:)?(?:[\w.@~-]*[\\/])+([\w.@-]*)/g, (match, base: string) =>
        (match.match(/[\\/]/g)?.length ?? 0) >= 2 || /^(?:[A-Za-z]:|[~.]*[\\/])/.test(match)
          ? base
          : match
      )
      .replace(/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_=-]{24,}/g, '')
      .replace(/\p{Extended_Pictographic}️?/gu, '')
      .replace(/[✓✔✅❌→]/g, '')
      .replace(/\s*(?:->|=>)\s*/g, ' to ')
      .replace(/\s&\s/g, ' and ')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
      .replace(/[*_]{2,}/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
  );
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function stripLeadIns(sentence: string): string {
  let text = sentence.trim();
  for (let pass = 0; pass < 3; pass++) {
    const next = text
      .replace(LEADING_FILLER, '')
      .replace(LEADING_PRONOUN, '')
      .replace(LEADING_ADVERB, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text.replace(/[.!?]+$/, '').trim();
}

/** Short heads of the list items that follow a colon-terminated line. */
function listItemsAfter(lines: CleanLine[], index: number): string[] {
  const heads: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.kind !== 'item') break;
    const head = line.text.split(/\s*(?::|\s[-—–]\s)\s*/)[0]!.replace(/[.!?]+$/, '');
    const words = head.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > MAX_LIST_ITEM_WORDS) return [];
    heads.push(words.map(lowerIfPlainWord).join(' '));
    if (heads.length === MAX_LIST_ITEMS) break;
  }
  return heads;
}

function joinList(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/** Caps a phrase at a few words, preferring to cut at a clause boundary. */
function clamp(text: string): string | null {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let kept = words;
  let truncated = false;
  if (kept.length > COMPLETION_SUMMARY_MAX_WORDS) {
    kept = kept.slice(0, COMPLETION_SUMMARY_MAX_WORDS);
    truncated = true;
  }
  while (kept.join(' ').length > COMPLETION_SUMMARY_MAX_CHARS && kept.length > 1) {
    kept = kept.slice(0, -1);
    truncated = true;
  }
  if (truncated) {
    let clauseEnd = kept.length - 1;
    while (clauseEnd >= 0 && !/[,;:]$/.test(kept[clauseEnd]!)) clauseEnd--;
    if (clauseEnd >= Math.floor(kept.length / 2)) kept = kept.slice(0, clauseEnd + 1);
  }
  let phrase = kept.join(' ');
  for (;;) {
    const trimmed = phrase.replace(/[\s,;:.!?\-—–(]+$/, '');
    const last = trimmed.split(' ').at(-1)?.toLowerCase() ?? '';
    phrase = truncated && TRAILING_FILLER.has(last) ? trimmed.slice(0, -last.length) : trimmed;
    if (phrase === trimmed) break;
  }
  const open = phrase.lastIndexOf('(');
  if (open > phrase.lastIndexOf(')')) phrase = phrase.slice(0, open).replace(/[\s,;:]+$/, '');
  phrase = phrase.replace(/^[\s,;:.!?\-—–)]+/, '').trim();
  return phrase || null;
}

function isGeneric(phrase: string): boolean {
  const content = phrase
    .toLowerCase()
    .split(/[^a-z0-9'+#-]+/)
    .filter((word) => word && !GENERIC_WORDS.has(word));
  return content.length < 2;
}

function isPastTenseVerb(word: string): boolean {
  const lower = word.toLowerCase();
  if (!/^[a-z]+$/i.test(word)) return false;
  // Capitalized acronyms or proper nouns ("NVIDIA", "Whisper") are not verbs.
  if (word.length > 1 && word.slice(1) !== word.slice(1).toLowerCase()) return false;
  if (IRREGULAR_PAST.has(lower)) return true;
  return (
    lower.length >= 5 && lower.endsWith('ed') && !lower.endsWith('eed') && !NOT_A_VERB.has(lower)
  );
}

function gerund(verb: string): string {
  if (DOUBLING_VERBS.has(verb)) return `${verb}${verb.at(-1)}ing`;
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`;
  if (/[^aeiouy]e$/.test(verb) || verb.endsWith('ue')) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

function lowerIfPlainWord(word: string): string {
  return /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word;
}

function isRandomSuffix(part: string): boolean {
  if (!/^[a-z0-9]{4,8}$/.test(part)) return false;
  return !/[aeiouy]/.test(part) || (/\d/.test(part) && /[a-z]/.test(part));
}
