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
  /** The agent's project, for "Atlas in Chorus" and "the latest agent in Chorus". */
  readonly projectName?: string;
  /** The conversation's own title when it differs from the spoken name (a second name it goes by). */
  readonly title?: string;
  /** When the agent's task was created (epoch ms), for "the latest agent". */
  readonly createdAt?: number;
};

export type Resolution =
  /** `fuzzy`: matched by a near spelling or sound, not by a name the agent actually has. */
  | { kind: 'match'; agent: RosterAgent; fuzzy?: true }
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

/** Lowercase letters and digits only, for comparing project names however they were spoken. */
function plainKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words too common to name a project by themselves ("the latest agent in the …"). */
const NOT_A_PROJECT = new Set(['the', 'this', 'that', 'here', 'there', 'one', 'all', 'any', 'new']);

/**
 * The project the spoken words name ("chorus", "ace combat", "the chorus project"): its exact
 * name, or whole words of exactly one project's name. Never part of a word, so "the" is not
 * "weather-app".
 */
export function spokenProject(roster: readonly RosterAgent[], words: string): string | null {
  const wanted = plainKey(words.replace(/\s+project$/i, '').replace(/^the\s+/i, ''));
  if (wanted.length < 3 || NOT_A_PROJECT.has(wanted)) return null;
  const names = [...new Set(roster.flatMap((agent) => agent.projectName ?? []))];
  const exact = names.filter((name) => plainKey(name) === wanted);
  const matched =
    exact.length > 0
      ? exact
      : names.filter((name) => ` ${plainKey(name)} `.includes(` ${wanted} `));
  return matched.length === 1 && matched[0] ? matched[0] : null;
}

const SCOPE_WORD = /^(?:in|on|from|under)$/i;

/**
 * True when `words` open with a project scope ("in chorus to run the tests", "in the ACE COMBAT
 * 8 project …"). The grammar uses it to keep a scope out of the message it sends.
 */
export function startsWithProjectScope(
  words: readonly string[],
  roster: readonly RosterAgent[]
): boolean {
  if (!SCOPE_WORD.test(words[0] ?? '')) return false;
  for (let length = 1; length <= 5 && length < words.length; length++) {
    if (spokenProject(roster, words.slice(1, 1 + length).join(' '))) return true;
  }
  return false;
}

const RECENCY =
  /^(?:the\s+)?(latest|newest|most recent|last|oldest|first)\s+(?:(.+?)\s+)?(?:agent|one|window|session|conversation)(?:\s+(?:we|i|you)\s+(?:had|have|were|was)\s+(?:running|going|open|working))?(?:\s+(?:in|on|for|from|under)\s+(.+))?$/i;
const NAME_IN_PROJECT = /^(.+?)\s+(?:in|from|on|under)\s+(?:the\s+)?(.+?)(?:\s+project)?$/i;

/**
 * References that pick an agent by recency or scope a name to a project: "the latest agent in
 * Chorus", "the newest Codex one", "Atlas in ACE COMBAT 8". Projects are named against the whole
 * roster; the agent comes from `pool`. Null when the words are neither.
 */
function resolveScoped(
  reference: string,
  roster: readonly RosterAgent[],
  pool: readonly RosterAgent[]
): Resolution | null {
  const text = describedText(reference);
  const recency = RECENCY.exec(text);
  // A bare "the last one" or "the first agent" says too little to act on.
  if (
    recency &&
    (recency[2] || recency[3] || /^(?:latest|newest|most recent)$/i.test(recency[1] ?? ''))
  ) {
    const oldest = /^(?:oldest|first)$/i.test(recency[1] ?? '');
    let candidates = pool;
    if (recency[3]) {
      const project = spokenProject(roster, recency[3]);
      // Not a project after all ("the latest agent on fire"): leave it to name matching.
      if (!project) return null;
      candidates = candidates.filter((agent) => agent.projectName === project);
    }
    const qualifier = recency[2]?.trim();
    if (qualifier) {
      // "the latest codex agent" names a provider; "the latest chorus agent" names a project.
      const provider = normalizeSpoken(qualifier).replace(/ code$/, '');
      const isProvider = roster.some((agent) => normalizeSpoken(agent.providerLabel) === provider);
      const project = isProvider ? null : spokenProject(roster, qualifier);
      if (!isProvider && !project) return null;
      candidates = candidates.filter((agent) =>
        isProvider
          ? normalizeSpoken(agent.providerLabel) === provider
          : agent.projectName === project
      );
    }
    // An agent still being created has no date yet and is the newest of all.
    const age = (agent: RosterAgent) => agent.createdAt ?? Number.MAX_SAFE_INTEGER;
    const ranked = [...candidates].sort((a, b) => (age(b) - age(a)) * (oldest ? -1 : 1));
    const best = ranked[0];
    if (!best) return { kind: 'none' };
    // One task can hold several agents created together: never pick between them silently.
    const tied = ranked.filter((agent) => age(agent) === age(best));
    return tied.length > 1
      ? { kind: 'ambiguous', candidates: tied }
      : { kind: 'match', agent: best };
  }

  const scoped = NAME_IN_PROJECT.exec(text);
  if (scoped?.[1] && scoped[2]) {
    const project = spokenProject(roster, scoped[2]);
    const spoken = normalizeSpoken(scoped[1]);
    // Scoped to a project, a miss is a miss: never fall back to a same-named agent elsewhere.
    if (project && spoken) {
      return resolveAmong(
        spoken,
        pool.filter((agent) => agent.projectName === project),
        'full'
      );
    }
  }
  return null;
}

/** "The Chorus agent": the agent of a project that has one, or a question when it has several. */
function resolveProjectAgent(reference: string, roster: readonly RosterAgent[]): Resolution {
  const qualifier = /^(?:the\s+)?(.+?)\s+(?:agent|one)$/i.exec(describedText(reference))?.[1];
  if (!qualifier) return { kind: 'none' };
  // "Codex one" is Codex 1, misheard or gone: never "the agent of the codex-plugin project".
  const spoken = normalizeSpoken(qualifier);
  if (
    /\d$/.test(normalizeSpoken(reference)) ||
    roster.some((agent) => normalizeSpoken(agent.providerLabel) === spoken)
  ) {
    return { kind: 'none' };
  }
  const project = spokenProject(roster, qualifier);
  const pool = project ? roster.filter((agent) => agent.projectName === project) : [];
  if (pool.length === 1 && pool[0]) return { kind: 'match', agent: pool[0] };
  if (pool.length > 1) return { kind: 'ambiguous', candidates: pool };
  return { kind: 'none' };
}

/**
 * The conversation's own title, when exactly one agent carries it and nothing matched by name:
 * "Vesper 3" for the agent the canvas calls Jasper 3.
 */
function resolveTitle(spoken: string, roster: readonly RosterAgent[]): Resolution {
  const titled = roster.filter((agent) => agent.title && normalizeSpoken(agent.title) === spoken);
  return titled.length === 1 && titled[0] ? { kind: 'match', agent: titled[0] } : { kind: 'none' };
}

function describedText(reference: string): string {
  return reference
    .trim()
    .replace(/[.!?,:]+$/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Resolves a spoken reference. Visible agents are tried first; closed or filtered-out agents are
 * only considered when no visible agent matches, so "open Bravo" can bring a closed window back
 * without making "codex" ambiguous against agents the user put away. With `mode` "name" only the
 * agent's own names count, never its task or a description: for places where any leading words
 * could be taken for a reference ("Sure, please provide…").
 */
export function resolveAgent(
  reference: string,
  roster: readonly RosterAgent[],
  focusedId: string | null,
  mode: 'full' | 'name' = 'full'
): Resolution {
  if (isDeictic(reference)) {
    const focused = roster.find((agent) => agent.id === focusedId);
    return focused ? { kind: 'match', agent: focused } : { kind: 'none' };
  }
  const spoken = normalizeSpoken(reference);
  if (!spoken) return { kind: 'none' };

  const visible = roster.filter((agent) => !agent.hidden);
  const hidden = roster.filter((agent) => agent.hidden);

  // "Atlas in ACE COMBAT 8" must not become the Atlas of another project, so a reference scoped
  // to a project is read before the bare name.
  if (mode === 'full') {
    let scoped = resolveScoped(reference, roster, visible);
    if (scoped?.kind === 'none' && hidden.length > 0) {
      scoped = resolveScoped(reference, roster, hidden);
    }
    if (scoped) return scoped;
  }

  let named = resolveAmong(spoken, visible, mode);
  if (named.kind === 'none' && hidden.length > 0) named = resolveAmong(spoken, hidden, mode);
  if (named.kind !== 'none') return named;
  const titled = resolveTitle(spoken, roster);
  if (titled.kind !== 'none' || mode === 'name') return titled;
  return resolveProjectAgent(reference, roster);
}

function resolveAmong(
  spoken: string,
  roster: readonly RosterAgent[],
  mode: 'full' | 'name'
): Resolution {
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
  const byTask =
    mode === 'name'
      ? []
      : roster.filter((agent) => {
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
    return { kind: 'match', agent: best.agent, fuzzy: true };
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
  if (sounding.length === 1 && sounding[0]) {
    return { kind: 'match', agent: sounding[0], fuzzy: true };
  }
  if (sounding.length > 1) return { kind: 'ambiguous', candidates: sounding };
  return { kind: 'none' };
}
