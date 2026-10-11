/**
 * Resolves spoken agent references ("clod two", "the codex one", "this one") against the roster.
 * Pure and deterministic: the conductor never guesses between two candidates.
 *
 * What a reference can match, strongest first:
 * 1. An agent's own name, open or closed. Nothing else outranks it.
 * 2. A name without its number ("Jasper" for Jasper 3), a provider, or a task.
 * 3. Another title or task name the agent alone goes by.
 * 4. A near spelling or sound of a name. Numbers are never part of the slack: "Atlas 3" is not
 *    Atlas, and not Atlas 2.
 */
import { AGENT_WINDOW_NAMES } from '@core/features/conversations/api/agent-window-names';

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
  /** Names it went by until a rename a short while ago, which the developer may still say. */
  readonly formerly?: readonly string[];
  /** When the agent's task was created (epoch ms), for "the latest agent". */
  readonly createdAt?: number;
};

/**
 * The agents that can be addressed. `departed` carries the names of agents that left a short
 * while ago (archived, deleted): saying one of those names an agent that is gone, and is never
 * read as a description of an agent that is still here.
 */
export type Roster = readonly RosterAgent[] & { readonly departed?: readonly string[] };

/** The other names an agent answers to: its title, and names it was renamed from. */
function aliasesOf(agent: RosterAgent): string[] {
  return [...(agent.title ? [agent.title] : []), ...(agent.formerly ?? [])];
}

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

const PROVIDER_ALIAS_PATTERNS = Object.entries(PROVIDER_ALIASES).map(
  ([alias, canonical]) => [new RegExp(`\\b${alias}\\b`, 'g'), canonical] as const
);

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
  for (const [alias, canonical] of PROVIDER_ALIAS_PATTERNS) {
    normalized = normalized.replace(alias, canonical);
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

/** A normalized name without its trailing number: "atlas 3" -> "atlas". */
export function nameBase(spoken: string): string {
  return spoken.replace(/ \d+$/, '');
}

/** A normalized name without any of its numbers: "gpt 5 reviewer" -> "gpt reviewer". */
function unnumbered(spoken: string): string {
  return spoken
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A closing word that is a number or an ordinary word: "Atlas too", "Atlas for". */
const NUMBER_HOMOPHONE = /\s+(?:to|too|for|fore|won|ate|tree)[.!?,]*\s*$/i;

const ROSTER_WORDS: ReadonlySet<string> = new Set(
  AGENT_WINDOW_NAMES.map((name) => name.toLowerCase())
);

/**
 * True for words shaped like a default agent name ("vesper", "atlas 3"). Such a reference names
 * an agent, so it never falls back to a task or project that happens to contain the word.
 */
function isRosterName(spoken: string): boolean {
  const match = /^([a-z]+)(?: \d+)?$/.exec(spoken);
  return !!match?.[1] && ROSTER_WORDS.has(match[1]);
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
      const within = (agents: readonly RosterAgent[]) =>
        agents.filter((agent) => agent.projectName === project);
      // Its own name reaches an agent whose window is closed, as it does without a project.
      const own = resolveOwnName(spoken, within(roster));
      return own.kind !== 'none' ? own : resolveIn(spoken, within(pool), 'full');
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
 * Another name one agent alone goes by, when nobody has it as a name: the conversation's own
 * title ("Vesper 3" for the agent the canvas calls Jasper 3), a name it was renamed from, or a
 * task named like an agent. Titles default per task, so one that several agents share names
 * none of them.
 */
function resolveAlias(
  spoken: string,
  roster: readonly RosterAgent[],
  mode: 'full' | 'name'
): Resolution {
  const titled = roster.filter((agent) =>
    aliasesOf(agent).some((alias) => normalizeSpoken(alias) === spoken)
  );
  const tasked =
    mode === 'full' && isRosterName(spoken)
      ? roster.filter((agent) => normalizeSpoken(agent.taskName) === spoken)
      : [];
  if (titled.length > 1 && tasked.length === 0) return { kind: 'none' };
  return oneOf([...new Set([...titled, ...tasked])]);
}

/** Words that describe an agent rather than name one: "the backend agent", "the codex one". */
const DESCRIPTION = /^the\s|\s(?:agent|one)$/i;

/**
 * The name of an agent that left the roster a short while ago, when `reference` is that name
 * and no agent here has it. Null otherwise.
 */
export function departedName(reference: string, roster: Roster): string | null {
  const spoken = normalizeSpoken(reference);
  if (!spoken) return null;
  const answered = roster.some((agent) =>
    [agent.name, ...aliasesOf(agent)].some((label) => normalizeSpoken(label) === spoken)
  );
  if (answered) return null;
  return roster.departed?.find((name) => normalizeSpoken(name) === spoken) ?? null;
}

/** The only candidate, a question between several, or nothing. */
function oneOf(candidates: readonly RosterAgent[]): Resolution {
  if (candidates.length === 1 && candidates[0]) return { kind: 'match', agent: candidates[0] };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates: [...candidates] };
  return { kind: 'none' };
}

function describedText(reference: string): string {
  return reference
    .trim()
    .replace(/[.!?,:]+$/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Resolves a spoken reference. An agent's own name always wins, whether its window is open or
 * closed. For everything else visible agents are tried first; closed or filtered-out agents are
 * only considered when no visible agent matches, so "open Bravo" can bring a closed window back
 * without making "codex" ambiguous against agents the user put away. With `mode` "name" only the
 * agent's own names count, never its task or a description: for places where any leading words
 * could be taken for a reference ("Sure, please provide…").
 */
export function resolveAgent(
  reference: string,
  roster: Roster,
  focusedId: string | null,
  mode: 'full' | 'name' = 'full'
): Resolution {
  if (isDeictic(reference)) {
    const focused = roster.find((agent) => agent.id === focusedId);
    return focused ? { kind: 'match', agent: focused } : { kind: 'none' };
  }
  const asNumber = resolveReference(reference, roster, mode);
  // "Stop Atlas too" is Atlas 2, or Atlas as well. The reading that names an agent wins; when
  // both do, it is a question.
  const plain = reference.replace(NUMBER_HOMOPHONE, '');
  if (plain === reference || !normalizeSpoken(plain)) return asNumber;
  const asWord = resolveAgent(plain, roster, focusedId, mode);
  if (asWord.kind !== 'match') return asNumber;
  if (asNumber.kind === 'none') return asWord;
  const numbered = asNumber.kind === 'match' ? [asNumber.agent] : asNumber.candidates;
  const readings = [asWord.agent, ...numbered.filter((agent) => agent.id !== asWord.agent.id)];
  return readings.length === 1 ? asWord : { kind: 'ambiguous', candidates: readings };
}

function resolveReference(reference: string, roster: Roster, mode: 'full' | 'name'): Resolution {
  const spoken = normalizeSpoken(reference);
  if (!spoken) return { kind: 'none' };

  // "Atlas 3" is the closed Atlas 3: never the open Atlas, and never an agent whose task or
  // title mentions it.
  const own = resolveOwnName(spoken, roster);
  if (own.kind !== 'none') return own;

  // "Backend" was archived a minute ago: the word is that agent's name, not a description of
  // the agent whose task mentions the backend. "The backend agent" still describes.
  if (departedName(reference, roster) && !DESCRIPTION.test(describedText(reference))) {
    return { kind: 'none' };
  }

  const visible = roster.filter((agent) => !agent.hidden);
  const hidden = roster.filter((agent) => agent.hidden);
  const tiers = [visible, hidden];

  // "Atlas in ACE COMBAT 8" must not become the Atlas of another project, so a reference scoped
  // to a project is read before the bare name.
  if (mode === 'full') {
    let scoped = resolveScoped(reference, roster, visible);
    if (scoped?.kind === 'none' && hidden.length > 0) {
      scoped = resolveScoped(reference, roster, hidden);
    }
    if (scoped) return scoped;
  }

  for (const pool of tiers) {
    const described = resolveDescribed(spoken, pool, mode);
    if (described.kind !== 'none') return described;
  }
  const alias = resolveAlias(spoken, roster, mode);
  if (alias.kind !== 'none') return alias;
  for (const pool of tiers) {
    const near = resolveNear(spoken, pool);
    if (near.kind !== 'none') return near;
  }
  return mode === 'name' ? { kind: 'none' } : resolveProjectAgent(reference, roster);
}

/** Every way of matching a reference within one set of agents (a project's, for a scope). */
function resolveIn(
  spoken: string,
  pool: readonly RosterAgent[],
  mode: 'full' | 'name'
): Resolution {
  for (const resolve of [resolveOwnName, resolveDescribed, resolveAlias]) {
    const resolution = resolve(spoken, pool, mode);
    if (resolution.kind !== 'none') return resolution;
  }
  return resolveNear(spoken, pool);
}

/**
 * An agent's own name ("claude 2"). Two agents can only share one after a rename; then the one
 * whose window is open wins, and two of a kind is a question.
 */
function resolveOwnName(spoken: string, roster: readonly RosterAgent[]): Resolution {
  let exact = roster.filter((agent) => normalizeSpoken(agent.name) === spoken);
  // "Atlas one" is plain Atlas: the first holder of a name carries no number.
  if (exact.length === 0 && / 1$/.test(spoken)) {
    const plain = spoken.replace(/ 1$/, '');
    exact = roster.filter((agent) => normalizeSpoken(agent.name) === plain);
  }
  const open = exact.filter((agent) => !agent.hidden);
  return oneOf(open.length > 0 ? open : exact);
}

/** What an agent is, short of its full name: its name without the number, provider, or task. */
function resolveDescribed(
  spoken: string,
  roster: readonly RosterAgent[],
  mode: 'full' | 'name'
): Resolution {
  if (roster.length === 0) return { kind: 'none' };

  // 1. The name without its number ("jasper" for Jasper 3), when no number was said. With a
  // number the name must exist as said.
  const byBase = /\d/.test(spoken)
    ? []
    : roster.filter((agent) => unnumbered(normalizeSpoken(agent.name)) === spoken);

  // 2. Provider alone ("codex") when exactly one agent of that provider exists. "Kilo" can be
  // the agent named Kilo 2 or the one Kilo agent: two readings are a question.
  const byProvider = roster.filter((agent) => normalizeSpoken(agent.providerLabel) === spoken);
  const named = [...new Set([...byBase, ...byProvider])];
  if (named.length > 0) return oneOf(named);

  // 3. Task name ("the auth agent" -> task "auth"). A reference shaped like an agent name
  // ("vesper", "atlas 3") names an agent, so it is never read as part of a task name.
  const byTask =
    mode === 'name' || isRosterName(spoken)
      ? []
      : roster.filter((agent) => {
          const task = normalizeSpoken(agent.taskName);
          return task === spoken || (spoken.length >= 4 && task.includes(spoken));
        });
  return oneOf(byTask);
}

/**
 * A near spelling or sound of a full name. The number is never part of the slack: a reference
 * and a name must carry the same one, so "Claude 2" is not "Claude 1" and "Atlas 3" is not
 * "Atlas". Said without a number, a near miss can still mean a numbered name ("at less" for
 * Atlas 3) when no unnumbered name is as close.
 */
function resolveNear(spoken: string, roster: readonly RosterAgent[]): Resolution {
  const spokenDigits = digitsOf(spoken);
  const named = roster.map((agent) => ({ agent, name: normalizeSpoken(agent.name) }));
  const sameNumber = closest(
    spoken,
    named.filter(({ name }) => digitsOf(name) === spokenDigits)
  );
  if (sameNumber.kind !== 'none' || spokenDigits) return sameNumber;
  return closest(
    spoken,
    named
      .filter(({ name }) => unnumbered(name) !== name)
      .map(({ agent, name }) => ({ agent, name: unnumbered(name) }))
  );
}

function closest(
  spoken: string,
  candidates: readonly { agent: RosterAgent; name: string }[]
): Resolution {
  // 1. Close misspelling, only when it is uniquely closest. Recognizers split and join words
  // freely ("at las", "codex1"), so spacing never counts as an edit.
  const spokenCompact = compact(spoken);
  const scored = candidates
    .map(({ agent, name }) => ({
      agent,
      distance: Math.min(editDistance(name, spoken), editDistance(compact(name), spokenCompact)),
    }))
    .filter(({ distance }) => distance <= Math.max(1, Math.floor(spokenCompact.length / 4)))
    .sort((a, b) => a.distance - b.distance);
  const best = scored[0];
  if (best) {
    const tied = scored.filter(({ distance }) => distance === best.distance);
    if (tied.length > 1) return { kind: 'ambiguous', candidates: tied.map(({ agent }) => agent) };
    return { kind: 'match', agent: best.agent, fuzzy: true };
  }

  // 2. Sounds like the name ("at less" -> Atlas, "brave oh" -> Bravo): the same full-length
  // phonetic key and still reasonably close in spelling. Unique matches only.
  if (spoken.replace(/[^a-z]/g, '').length < 4) return { kind: 'none' };
  const spokenKey = phoneticKey(spoken);
  const sounding = candidates.filter(({ name }) => {
    if (phoneticKey(name) !== spokenKey) return false;
    const nameCompact = compact(name);
    const longest = Math.max(nameCompact.length, spokenCompact.length);
    return editDistance(nameCompact, spokenCompact) <= Math.floor(longest / 2);
  });
  if (sounding.length === 1 && sounding[0]) {
    return { kind: 'match', agent: sounding[0].agent, fuzzy: true };
  }
  return oneOf(sounding.map(({ agent }) => agent));
}

/**
 * Labels for a "which one?" question. Agents that share a name are told apart by project, or by
 * task when they share the project too, so the question is never "Atlas or Atlas?".
 */
export function candidateLabels(candidates: readonly RosterAgent[]): string[] {
  return candidates.map((agent) => {
    const twins = candidates.filter(
      (other) => other !== agent && normalizeSpoken(other.name) === normalizeSpoken(agent.name)
    );
    if (twins.length === 0) return agent.name;
    const project = agent.projectName;
    return project && twins.every((other) => other.projectName !== project)
      ? `${agent.name} in ${project}`
      : `${agent.name} on "${agent.taskName}"`;
  });
}

/**
 * The agents a name nobody has comes closest to, for "did you mean" questions: the same word
 * under another number, or a word one letter or one sound away.
 */
export function similarAgents(reference: string, roster: readonly RosterAgent[]): RosterAgent[] {
  const word = nameBase(normalizeSpoken(reference));
  if (!word) return [];
  const key = phoneticKey(word);
  return roster.filter((agent) => {
    const base = nameBase(normalizeSpoken(agent.name));
    if (base === word) return true;
    if (word.length < 4 || !base) return false;
    const distance = editDistance(compact(base), compact(word));
    const longest = Math.max(compact(base).length, compact(word).length);
    return distance <= 1 || (phoneticKey(base) === key && distance <= Math.floor(longest / 2));
  });
}

/** Number words a recognizer writes that cannot be anything else (unlike "to", "for", "won"). */
const SPOKEN_NUMBERS: Record<string, string> = {
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
};

type SpokenToken = {
  readonly word: string;
  /** Possessive: "Atlas 3's branch", "what's". */
  readonly owns: boolean;
  /** A comma or colon follows: "Atlas, run the tests". */
  readonly pause: boolean;
};

/** The words of a transcript or a name, for finding one inside the other. */
function spokenTokens(text: string): SpokenToken[] {
  const spaced = text.toLowerCase().replace(/([a-z])(\d)/g, '$1 $2');
  return [...spaced.matchAll(/([a-z]+|\d+)(['’]s\b)?(\s*[,:])?/g)].map((match) => ({
    word: SPOKEN_NUMBERS[match[1] ?? ''] ?? match[1] ?? '',
    owns: Boolean(match[2]),
    pause: Boolean(match[3]),
  }));
}

function nameTokens(text: string): string[] {
  return spokenTokens(text).map((token) => token.word);
}

/** A number a default agent name can carry ("Atlas 2" up). */
const NAME_NUMBER = /^(?:[2-9]|[1-9]\d)$/;

/** Words that make the number before them a count. */
const COUNTED_AFTER =
  /^(?:things?|times?|more|questions?|options?|minutes?|seconds?|hours?|days?|percent)$/;

/** Where a name is said in a transcript: its first word, and the word after its last. */
type Mention = { readonly start: number; readonly end: number };

/** Every place `label` is said as whole words. "Atlas 3" does not say "Atlas". */
function mentionsOf(tokens: readonly SpokenToken[], label: string): Mention[] {
  const wanted = nameTokens(label);
  if (wanted.length === 0) return [];
  const numbered = NAME_NUMBER.test(wanted[wanted.length - 1] ?? '');
  const mentions: Mention[] = [];
  for (let start = 0; start + wanted.length <= tokens.length; start++) {
    if (!wanted.every((word, offset) => tokens[start + offset]?.word === word)) continue;
    const end = start + wanted.length;
    // "Atlas 3" is another name; "Atlas two things" is Atlas and a count.
    const number = NAME_NUMBER.test(tokens[end]?.word ?? '');
    if (!numbered && number && !COUNTED_AFTER.test(tokens[end + 1]?.word ?? '')) continue;
    mentions.push({ start, end });
  }
  return mentions;
}

/** Words an utterance opens with before the command itself: "hey Maestro, can you …". */
const LEAD_IN = new Set([
  'hey',
  'hi',
  'ok',
  'okay',
  'so',
  'um',
  'uh',
  'please',
  'chorus',
  'maestro',
  'alright',
  'can',
  'could',
  'would',
  'will',
  'you',
  'just',
  'no',
  'nope',
  'yes',
  'yeah',
  'actually',
  'wait',
  'sorry',
  'and',
  'then',
  'now',
  'also',
]);

/** How a command opens when the name right after is who it is for: "tell Atlas 3 …". */
const COMMAND_FOR =
  /^(?:tell|ask|have|let|get|message(?: for)?|ping|remind|send|give|i want|i need|focus(?: on)?|open|show(?: me)?|go to|switch to|jump to|talk to|stop|interrupt|pause|close|hide|reopen|kill|archive|allow|deny|approve|what's|whats|how's|hows|(?:what|how) is|is|status (?:of|for))$/;

/** How a command opens when it hands something to the name that closes it: "send that to …". */
const HANDED_TO = /^(?:send|give|forward|pass|resend|type|say|write|hand|move)\b.* to$/;

/** Words that may follow "… to Atlas 3" at the end of a command. */
const CLOSING = new Set(['instead', 'please', 'too', 'now', 'thanks', 'again']);

/**
 * True when the name at `mention` is who the command is for: "tell Atlas 3 …", "send that to
 * Atlas 3", "Atlas 3, run the tests", "what's Atlas 3 doing". Only the opening of the command
 * counts. A name said along the way is not addressed: "rebase onto Atlas 3's branch", "tell it
 * to ask Atlas 3 for the schema" (that command is for "it"), "tell Atlas two things".
 */
function isAddressed(tokens: readonly SpokenToken[], mention: Mention): boolean {
  const last = tokens[mention.end - 1];
  if (!last || last.owns) return false;
  if (COUNTED_AFTER.test(tokens[mention.end]?.word ?? '')) return false;
  let opening = 0;
  while (opening < mention.start && LEAD_IN.has(tokens[opening]?.word ?? '')) opening++;
  const before = tokens
    .slice(opening, mention.start)
    .map((token) => (token.owns ? `${token.word}'s` : token.word))
    .join(' ');
  // Opening the utterance, a name is somebody called by name when its comma says so.
  if (before === '') return last.pause;
  if (COMMAND_FOR.test(before)) return true;
  const after = tokens.slice(mention.end);
  return HANDED_TO.test(before) && after.every(({ word }) => CLOSING.has(word));
}

/**
 * Agent names said in `utterance` that no agent has, as a name, another name, or a task:
 * "Atlas 3" when only Atlas and Atlas 2 exist, or an agent archived a moment ago that the
 * developer is still talking to. A default name with a number can only mean an agent, so one
 * that matches nobody is an agent that is gone or a number heard wrong, and what was said must
 * not go to another agent in its place.
 */
export function unknownSpokenNames(utterance: string, roster: Roster): string[] {
  const tokens = spokenTokens(utterance);
  const word = (index: number) => tokens[index]?.word ?? '';
  const unknown: string[] = [];
  const known = (spoken: string) =>
    roster.some((agent) =>
      [agent.name, agent.taskName, ...aliasesOf(agent)].some(
        (label) => normalizeSpoken(label) === spoken
      )
    );
  for (const index of tokens.keys()) {
    if (!ROSTER_WORDS.has(word(index)) || !NAME_NUMBER.test(word(index + 1))) continue;
    // "The Delta 2 migration", "echo 42 to stdout", and "upgrade to Quartz 2" are things; a
    // name counts where the developer is talking to it.
    if (!isAddressed(tokens, { start: index, end: index + 2 })) continue;
    const label = `${word(index).charAt(0).toUpperCase()}${word(index).slice(1)} ${word(index + 1)}`;
    if (!known(`${word(index)} ${word(index + 1)}`) && !unknown.includes(label)) {
      unknown.push(label);
    }
  }
  // A plain word can be a name or just a word ("echo the path"): the name of an agent that left
  // only counts where the developer is plainly talking to it.
  for (const name of roster.departed ?? []) {
    if (known(normalizeSpoken(name)) || unknown.includes(name)) continue;
    if (mentionsOf(tokens, name).some((mention) => isAddressed(tokens, mention))) {
      unknown.push(name);
    }
  }
  return unknown;
}

/** True when `utterance` says one of this agent's names, and not a numbered sibling of it. */
function saysAgent(tokens: readonly SpokenToken[], agent: RosterAgent): boolean {
  return [agent.name, ...aliasesOf(agent)].some((label) => mentionsOf(tokens, label).length > 0);
}

/**
 * Why an action must not go to `target`, or null when it is fine. Two cases, both the developer
 * naming one agent and the action reaching another:
 * - they said a name no agent has ("Atlas 3" with only Atlas and Atlas 2), and not this one's;
 * - the command is for an agent whose name differs from this one's only by its number ("tell
 *   Atlas 3 …" when the action is headed for Atlas), and they did not say this one's.
 * This is what keeps "Atlas 3" from being quietly sent to Atlas, to the focused agent, or to
 * whichever agent seems likeliest. A name that is only mentioned ("rebase onto Atlas 3's
 * branch") refuses nothing.
 */
export function substitutionRefusal(
  utterance: string,
  target: RosterAgent,
  roster: Roster
): string | null {
  const tokens = spokenTokens(utterance);
  if (saysAgent(tokens, target)) return null;
  const said = unknownSpokenNames(utterance, roster)[0];
  if (said) {
    const near = similarAgents(said, roster).map((agent) => agent.name);
    const closest = near.length > 0 ? ` (closest: ${near.join(', ')})` : '';
    return `The developer said "${said}", and no agent has that name${closest}. Do not use ${target.name} or any other agent in its place: ask which agent they mean, or call find_conversations if it may be archived.`;
  }
  const word = nameBase(normalizeSpoken(target.name));
  const sibling = roster.find(
    (other) =>
      other.id !== target.id &&
      nameBase(normalizeSpoken(other.name)) === word &&
      mentionsOf(tokens, other.name).some((mention) => isAddressed(tokens, mention))
  );
  return sibling
    ? `The developer is talking to "${sibling.name}", which is a different agent from ${target.name}. Act on ${sibling.name}, or ask which one they mean.`
    : null;
}
