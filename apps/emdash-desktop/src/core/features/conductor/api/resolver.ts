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

const DEICTIC = new Set(['this', 'this one', 'it', 'here', 'current', 'the current one', 'that one']);

export function normalizeSpoken(text: string): string {
  // "the codex one" describes an agent ("the Codex agent"); "codex one" names Codex 1.
  const descriptive = /^\s*the\s.+\sone[.!?]?\s*$/i.test(text);
  let normalized = (descriptive ? text.replace(/\sone[.!?]?\s*$/i, '') : text)
    .toLowerCase()
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
    .replace(/ (one|agent)$/, '')
    .trim();
}

function digitsOf(text: string): string {
  return (text.match(/\d+/g) ?? []).join(' ');
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

export function resolveAgent(
  reference: string,
  roster: readonly RosterAgent[],
  focusedId: string | null
): Resolution {
  const spoken = normalizeSpoken(reference);
  if (!spoken) return { kind: 'none' };

  if (DEICTIC.has(spoken) || DEICTIC.has(reference.trim().toLowerCase())) {
    const focused = roster.find((agent) => agent.id === focusedId);
    return focused ? { kind: 'match', agent: focused } : { kind: 'none' };
  }

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
  // fuzzed: "Claude 2" must not resolve to "Claude 1".
  const spokenDigits = digitsOf(spoken);
  const scored = roster
    .filter((agent) => {
      const nameDigits = digitsOf(normalizeSpoken(agent.name));
      return !spokenDigits || !nameDigits || spokenDigits === nameDigits;
    })
    .map((agent) => ({ agent, distance: editDistance(normalizeSpoken(agent.name), spoken) }))
    .filter(({ distance }) => distance <= Math.max(1, Math.floor(spoken.length / 4)))
    .sort((a, b) => a.distance - b.distance);
  const best = scored[0];
  if (!best) return { kind: 'none' };
  const tied = scored.filter(({ distance }) => distance === best.distance);
  if (tied.length > 1) return { kind: 'ambiguous', candidates: tied.map(({ agent }) => agent) };
  return { kind: 'match', agent: best.agent };
}
