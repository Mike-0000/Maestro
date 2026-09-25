/**
 * Resolves spoken agent references ("clod two", "the codex one", "this one") against the roster.
 * Pure and deterministic: the conductor never guesses between two candidates.
 */

export type RosterAgent = {
  readonly id: string;
  /** Spoken name, e.g. "Claude 2". */
  readonly name: string;
  readonly providerLabel: string;
  readonly taskName: string;
  /** Closed (hidden from the canvas) or filtered out: still addressable, but visible agents win. */
  readonly hidden?: boolean;
};

export type Resolution =
  | { kind: 'match'; agent: RosterAgent }
  | { kind: 'ambiguous'; candidates: RosterAgent[] }
  | { kind: 'none' };

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  won: '1',
  two: '2',
  to: '2',
  too: '2',
  three: '3',
  tree: '3',
  four: '4',
  for: '4',
  fore: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  ate: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
};

/** Common speech-to-text mishearings of provider names. */
const PROVIDER_ALIASES: Record<string, string> = {
  clod: 'claude',
  cloud: 'claude',
  claud: 'claude',
  clode: 'claude',
  klaud: 'claude',
  codecs: 'codex',
  codec: 'codex',
  kodex: 'codex',
  'code x': 'codex',
  gemeni: 'gemini',
  jiminy: 'gemini',
  curser: 'cursor',
};

const DEICTIC = new Set([
  'this',
  'this one',
  'it',
  'here',
  'current',
  'the current one',
  'that',
  'that one',
  'focused',
  'selected',
]);

/** Words that name an agent's window rather than the agent ("close Atlas's window"). */
const WINDOW_NOUN = /(?:^| )(?:window|tile|terminal|tab|pane|panel|session)s?$/;

export function normalizeSpoken(text: string): string {
  // "the codex one" describes an agent ("the Codex agent"); "codex one" names Codex 1.
  const descriptive = /^\s*the\s.+\sone[.!?]?\s*$/i.test(text);
  let normalized = (descriptive ? text.replace(/\sone[.!?]?\s*$/i, '') : text)
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [alias, canonical] of Object.entries(PROVIDER_ALIASES)) {
    normalized = normalized.replace(new RegExp(`\\b${alias}\\b`, 'g'), canonical);
  }
  return normalized
    .split(' ')
    .map((word) => NUMBER_WORDS[word] ?? word)
    .join(' ')
    .replace(/^the /, '')
    .replace(WINDOW_NOUN, '')
    .replace(/ (one|agent)$/, '')
    .trim();
}

/** True when `reference` means "the focused agent" ("this one", "it", "this window"). */
export function isDeictic(reference: string): boolean {
  const raw = reference.trim().toLowerCase();
  if (DEICTIC.has(raw)) return true;
  const spoken = normalizeSpoken(reference);
  // "this window" -> "this"; a bare "window" normalizes to nothing.
  return DEICTIC.has(spoken) || (spoken === '' && WINDOW_NOUN.test(raw));
}

function digitsOf(text: string): string {
  return (text.match(/\d+/g) ?? []).join(' ');
}

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0;
      const left = previous[j - 1] ?? 0;
      previous[j] = Math.min(above + 1, left + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

const PHONETIC_CODES: Record<string, string> = {
  b: '1',
  f: '1',
  p: '1',
  v: '1',
  c: '2',
  g: '2',
  j: '2',
  k: '2',
  q: '2',
  s: '2',
  x: '2',
  z: '2',
  d: '3',
  t: '3',
  l: '4',
  m: '5',
  n: '5',
  r: '6',
};

/**
 * A full-length Soundex-style key of the letters in `text` ("at less" and "Atlas" both give
 * "V342"). Unlike Soundex it is never truncated, so a name plus trailing words never matches the
 * name alone, and a leading consonant is coded like any other so "Cedar" and "Seder" agree.
 */
export function phoneticKey(text: string): string {
  const letters = text.toLowerCase().replace(/[^a-z]/g, '');
  let key = '';
  let previous = '';
  for (const [index, letter] of letters.split('').entries()) {
    const code = PHONETIC_CODES[letter];
    if (code === undefined) {
      if (index === 0) key = 'V';
      // Vowels separate repeated codes; h, w, and y do not.
      if (!'hwy'.includes(letter)) previous = '';
      continue;
    }
    if (code !== previous) key += code;
    previous = code;
  }
  return key;
}

/**
 * Resolves a spoken reference. Visible agents are tried first; closed or filtered-out agents are
 * only considered when no visible agent matches, so "open Bravo" can bring a closed window back
 * without making "codex" ambiguous against agents the user put away.
 */
export function resolveAgent(
  reference: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): Resolution {
  if (isDeictic(reference)) {
    const focused = roster.find((agent) => agent.id === focusedId);
    return focused ? { kind: 'match', agent: focused } : { kind: 'none' };
  }
  const spoken = normalizeSpoken(reference);
  if (!spoken) return { kind: 'none' };

  const visible = roster.filter((agent) => !agent.hidden);
  const first = resolveAmong(spoken, visible);
  if (first.kind !== 'none' || visible.length === roster.length) return first;
  return resolveAmong(
    spoken,
    roster.filter((agent) => agent.hidden)
  );
}

function resolveAmong(spoken: string, roster: readonly RosterAgent[]): Resolution {
  if (roster.length === 0) return { kind: 'none' };

  // 1. Exact spoken name ("claude 2").
  const exact = roster.filter((agent) => normalizeSpoken(agent.name) === spoken);
  if (exact.length === 1 && exact[0]) return { kind: 'match', agent: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

  // 2. Provider alone ("codex") when exactly one agent of that provider exists.
  const byProvider = roster.filter((agent) => normalizeSpoken(agent.providerLabel) === spoken);
  if (byProvider.length === 1 && byProvider[0]) return { kind: 'match', agent: byProvider[0] };
  if (byProvider.length > 1) return { kind: 'ambiguous', candidates: byProvider };

  // 3. Task name ("the auth agent" -> task "auth").
  const byTask = roster.filter((agent) => {
    const task = normalizeSpoken(agent.taskName);
    return task === spoken || (spoken.length >= 4 && task.includes(spoken));
  });
  if (byTask.length === 1 && byTask[0]) return { kind: 'match', agent: byTask[0] };
  if (byTask.length > 1) return { kind: 'ambiguous', candidates: byTask };

  // 4. Close misspelling of a full name, only when it is uniquely closest. Numbers are never
  // fuzzed: "Claude 2" must not resolve to "Claude 1". Recognizers split and join words freely
  // ("at las", "codex1"), so spacing never counts as an edit.
  const spokenDigits = digitsOf(spoken);
  const candidates = roster.filter((agent) => {
    const nameDigits = digitsOf(normalizeSpoken(agent.name));
    return !spokenDigits || !nameDigits || spokenDigits === nameDigits;
  });
  const spokenCompact = compact(spoken);
  const scored = candidates
    .map((agent) => {
      const name = normalizeSpoken(agent.name);
      const distance = Math.min(
        editDistance(name, spoken),
        editDistance(compact(name), spokenCompact)
      );
      return { agent, distance };
    })
    .filter(({ distance }) => distance <= Math.max(1, Math.floor(spokenCompact.length / 4)))
    .sort((a, b) => a.distance - b.distance);
  const best = scored[0];
  if (best) {
    const tied = scored.filter(({ distance }) => distance === best.distance);
    if (tied.length > 1) return { kind: 'ambiguous', candidates: tied.map(({ agent }) => agent) };
    return { kind: 'match', agent: best.agent };
  }

  // 5. Sounds like a full name ("at less" -> Atlas, "brave oh" -> Bravo): the same full-length
  // phonetic key, the same digits, and still reasonably close in spelling. Unique matches only.
  if (spoken.replace(/[^a-z]/g, '').length < 4) return { kind: 'none' };
  const spokenKey = phoneticKey(spoken);
  const sounding = candidates.filter((agent) => {
    const name = normalizeSpoken(agent.name);
    if (digitsOf(name) !== spokenDigits || phoneticKey(name) !== spokenKey) return false;
    const nameCompact = compact(name);
    const longest = Math.max(nameCompact.length, spokenCompact.length);
    return editDistance(nameCompact, spokenCompact) <= Math.floor(longest / 2);
  });
  if (sounding.length === 1 && sounding[0]) return { kind: 'match', agent: sounding[0] };
  if (sounding.length > 1) return { kind: 'ambiguous', candidates: sounding };
  return { kind: 'none' };
}
