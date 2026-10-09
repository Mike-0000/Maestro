import { describe, expect, it } from 'vitest';
import {
  editDistance,
  isDeictic,
  normalizeSpoken,
  phoneticKey,
  resolveAgent,
  type RosterAgent,
} from './resolver';

const roster: RosterAgent[] = [
  { id: 'c1', name: 'Claude 1', providerLabel: 'Claude', taskName: 'auth-refactor' },
  { id: 'c2', name: 'Claude 2', providerLabel: 'Claude', taskName: 'settings-page' },
  { id: 'x1', name: 'Codex 1', providerLabel: 'Codex', taskName: 'api tests' },
];

describe('normalizeSpoken', () => {
  it('maps number words, homophones, and misheard providers', () => {
    expect(normalizeSpoken('Clod Two')).toBe('claude 2');
    expect(normalizeSpoken('the codecs one')).toBe('codex');
    expect(normalizeSpoken('Claude-2!')).toBe('claude 2');
  });
});

describe('resolveAgent', () => {
  it('matches exact spoken names', () => {
    expect(resolveAgent('Claude two', roster, null)).toMatchObject({
      kind: 'match',
      agent: { id: 'c2' },
    });
  });

  it('resolves a unique provider, and asks when a provider is shared', () => {
    expect(resolveAgent('codex', roster, null)).toMatchObject({
      kind: 'match',
      agent: { id: 'x1' },
    });
    expect(resolveAgent('claude', roster, null).kind).toBe('ambiguous');
  });

  it('resolves deictic references to the focused agent only', () => {
    expect(resolveAgent('this one', roster, 'c1')).toMatchObject({ agent: { id: 'c1' } });
    expect(resolveAgent('this one', roster, null).kind).toBe('none');
  });

  it('resolves by task name', () => {
    expect(resolveAgent('the settings agent', roster, null)).toMatchObject({
      agent: { id: 'c2' },
    });
    expect(resolveAgent('api tests', roster, null)).toMatchObject({ agent: { id: 'x1' } });
  });

  it('never fuzzes numbers', () => {
    const single = [roster[0] as RosterAgent];
    expect(resolveAgent('Claude 2', single, null).kind).toBe('none');
    expect(resolveAgent('Claude 3', roster, null).kind).toBe('none');
  });

  it('tolerates small misspellings of full names', () => {
    expect(resolveAgent('Claud 1', roster, null)).toMatchObject({ agent: { id: 'c1' } });
    expect(resolveAgent('Kodex 1', roster, null)).toMatchObject({ agent: { id: 'x1' } });
  });

  it('returns none for unrelated words', () => {
    expect(resolveAgent('banana', roster, null).kind).toBe('none');
  });
});

describe('editDistance', () => {
  it('computes Levenshtein distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
  });
});

describe('roster names', () => {
  const named: RosterAgent[] = [
    { id: 'a', name: 'Atlas', providerLabel: 'Claude', taskName: 'auth' },
    { id: 'b', name: 'Bravo', providerLabel: 'Codex', taskName: 'api-tests' },
    { id: 'c', name: 'Cedar', providerLabel: 'Codex', taskName: 'docs', hidden: true },
  ];

  it('matches misheard names by sound', () => {
    expect(phoneticKey('at less')).toBe(phoneticKey('Atlas'));
    expect(resolveAgent('at less', named, null)).toMatchObject({ agent: { id: 'a' } });
    expect(resolveAgent('brave oh', named, null)).toMatchObject({ agent: { id: 'b' } });
  });

  it('strips window nouns and possessives', () => {
    expect(normalizeSpoken("Atlas's window")).toBe('atlas');
    expect(resolveAgent('the bravo terminal', named, null)).toMatchObject({ agent: { id: 'b' } });
  });

  it('prefers visible agents but still finds closed ones', () => {
    // "codex" would be ambiguous if the closed Cedar counted.
    expect(resolveAgent('codex', named, null)).toMatchObject({ agent: { id: 'b' } });
    expect(resolveAgent('cedar', named, null)).toMatchObject({ agent: { id: 'c' } });
  });

  it('resolves deictic references to the focused agent', () => {
    expect(isDeictic('this one')).toBe(true);
    expect(isDeictic('that window')).toBe(true);
    expect(isDeictic('atlas')).toBe(false);
    expect(resolveAgent('this one', named, 'b')).toMatchObject({ agent: { id: 'b' } });
    expect(resolveAgent('this one', named, null).kind).toBe('none');
  });

  it('does not match short or unrelated words by sound', () => {
    expect(resolveAgent('at', named, null).kind).toBe('none');
    expect(resolveAgent('brief', named, null).kind).toBe('none');
  });
});

/** The roster from the developer's logs: agents across three projects, started hours apart. */
const HOUR = 3_600_000;
const projects: RosterAgent[] = [
  {
    id: 'atlas',
    name: 'Atlas 3',
    providerLabel: 'Claude',
    taskName: 'Redesign admin and leaderboard menus',
    projectName: 'Mikes-Invade-and-Annex-Exp',
    createdAt: 1 * HOUR,
  },
  {
    id: 'echo',
    name: 'Echo 3',
    providerLabel: 'Claude',
    taskName: 'modding-feasability',
    projectName: 'ACE COMBAT 8',
    createdAt: 2 * HOUR,
  },
  {
    id: 'lima',
    name: 'Lima 3',
    providerLabel: 'Claude',
    taskName: 'Harder difficulty mode investigation',
    projectName: 'ACE COMBAT 8',
    createdAt: 5 * HOUR,
  },
  {
    id: 'jasper',
    name: 'Jasper 3',
    providerLabel: 'Claude',
    taskName: 'Vesper 2',
    projectName: 'chorus',
    title: 'Vesper 3',
    createdAt: 3 * HOUR,
  },
  {
    id: 'pilot',
    name: 'Pilot 3',
    providerLabel: 'Codex',
    taskName: 'Phone push notifications for agents',
    projectName: 'chorus',
    createdAt: 6 * HOUR,
  },
  {
    id: 'umber',
    name: 'Umber 3',
    providerLabel: 'Claude',
    taskName: 'Revamp voice agent control and data',
    projectName: 'chorus',
    createdAt: 7 * HOUR,
  },
];

describe('resolveAgent descriptions', () => {
  it('finds the latest agent in a project', () => {
    expect(resolveAgent('the latest agent in this chorus project', projects, null).kind).toBe(
      'none'
    );
    expect(resolveAgent('the latest agent in chorus', projects, null)).toMatchObject({
      agent: { id: 'umber' },
    });
    expect(resolveAgent('the latest agent in the Chorus project', projects, null)).toMatchObject({
      agent: { id: 'umber' },
    });
    expect(resolveAgent('the newest ace combat agent', projects, null)).toMatchObject({
      agent: { id: 'lima' },
    });
    expect(resolveAgent('latest agent', projects, null)).toMatchObject({ agent: { id: 'umber' } });
  });

  it('narrows the latest agent by provider', () => {
    expect(resolveAgent('the latest codex agent', projects, null)).toMatchObject({
      agent: { id: 'pilot' },
    });
    expect(resolveAgent('the latest claude code agent in chorus', projects, null)).toMatchObject({
      agent: { id: 'umber' },
    });
    expect(resolveAgent('the oldest agent in chorus', projects, null)).toMatchObject({
      agent: { id: 'jasper' },
    });
  });

  it('never acts on a bare "the last one"', () => {
    expect(resolveAgent('the last one', projects, null).kind).toBe('none');
    expect(resolveAgent('the first agent', projects, null).kind).toBe('none');
  });

  it('keeps a name inside the project it was said with', () => {
    // "Atlas in ACE COMBAT 8": no Atlas there, so it must not become the Atlas of another project.
    expect(resolveAgent('Atlas in the ACE COMBAT 8 project', projects, null).kind).toBe('none');
    expect(resolveAgent('Atlas in ACE COMBAT 8', projects, null).kind).toBe('none');
    expect(resolveAgent('Lima in ace combat', projects, null)).toMatchObject({
      agent: { id: 'lima' },
    });
    expect(resolveAgent('Atlas', projects, null)).toMatchObject({ agent: { id: 'atlas' } });
  });

  it('asks which one when a project has several agents', () => {
    expect(resolveAgent('the chorus agent', projects, null).kind).toBe('ambiguous');
    expect(resolveAgent('the invade and annex agent', projects, null)).toMatchObject({
      agent: { id: 'atlas' },
    });
  });

  it("matches the conversation's own title", () => {
    expect(resolveAgent('Vesper 3', projects, null)).toMatchObject({ agent: { id: 'jasper' } });
  });

  it('never lets a title outrank a name or split between two agents', () => {
    // Titles default per task: Bravo can be titled "Atlas" while a closed Atlas exists.
    const titled: RosterAgent[] = [
      { id: 'a', name: 'Atlas', providerLabel: 'Claude', taskName: 'one', hidden: true },
      { id: 'b', name: 'Bravo', providerLabel: 'Claude', taskName: 'two', title: 'Atlas' },
      { id: 'c', name: 'Cedar', providerLabel: 'Codex', taskName: 'three', title: 'Claude' },
    ];
    expect(resolveAgent('Atlas', titled, null)).toMatchObject({ agent: { id: 'a' } });
    // The one visible Claude agent, not the Codex agent titled "Claude".
    expect(resolveAgent('claude', titled, null)).toMatchObject({ agent: { id: 'b' } });
    const shared = titled.slice(1).map((agent) => ({ ...agent, title: 'Vesper' }));
    expect(resolveAgent('Vesper', shared, null).kind).toBe('none');
  });

  it('prefers visible agents for recency and project scopes', () => {
    const closed: RosterAgent = {
      id: 'closed',
      name: 'Zulu 3',
      providerLabel: 'Claude',
      taskName: 'put away',
      projectName: 'chorus',
      createdAt: 9 * HOUR,
      hidden: true,
    };
    const roster = [...projects, closed];
    expect(resolveAgent('the latest agent in chorus', roster, null)).toMatchObject({
      agent: { id: 'umber' },
    });
    expect(resolveAgent('Zulu in chorus', roster, null)).toMatchObject({ agent: { id: 'closed' } });
  });

  it('counts an agent that is still being created as the newest', () => {
    const starting: RosterAgent = {
      id: 'new',
      name: 'Victor 3',
      providerLabel: 'Claude',
      taskName: 'just asked for',
      projectName: 'chorus',
    };
    expect(resolveAgent('the newest agent', [...projects, starting], null)).toMatchObject({
      agent: { id: 'new' },
    });
  });

  it('matches project names by whole words only', () => {
    const roster: RosterAgent[] = [
      { ...projects[0]!, id: 'w', name: 'Echo', projectName: 'weather-app' },
      {
        ...projects[0]!,
        id: 'p',
        name: 'Papa',
        providerLabel: 'Claude',
        projectName: 'codex-plugin',
      },
      { ...projects[0]!, id: 'x', name: 'Xray', projectName: 'brother-app' },
    ];
    expect(resolveAgent('the latest agent in the', roster, null).kind).toBe('none');
    expect(resolveAgent('the other one', roster, null).kind).toBe('none');
    expect(resolveAgent('codex one', roster, null).kind).toBe('none');
    expect(resolveAgent('the weather app agent', roster, null)).toMatchObject({
      agent: { id: 'w' },
    });
    expect(resolveAgent('the latest release agent', roster, null).kind).toBe('none');
  });

  it('marks near-miss names as fuzzy and real names as not', () => {
    expect(resolveAgent('Lima 3', projects, null)).toEqual({ kind: 'match', agent: projects[2] });
    expect(resolveAgent('Lima 3 how', projects, null)).toMatchObject({ fuzzy: true });
  });

  it('ignores tasks and descriptions when only names count', () => {
    const sure: RosterAgent[] = [
      { id: 'iris', name: 'Iris 2', providerLabel: 'Claude', taskName: 'make sure push works' },
    ];
    expect(resolveAgent('Sure', sure, null)).toMatchObject({ agent: { id: 'iris' } });
    expect(resolveAgent('Sure', sure, null, 'name').kind).toBe('none');
    expect(resolveAgent('the latest agent in chorus', projects, null, 'name').kind).toBe('none');
  });
});
