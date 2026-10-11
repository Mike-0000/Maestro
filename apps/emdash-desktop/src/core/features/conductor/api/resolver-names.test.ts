import { describe, expect, it } from 'vitest';
import {
  candidateLabels,
  departedName,
  resolveAgent,
  similarAgents,
  substitutionRefusal,
  unknownSpokenNames,
  type RosterAgent,
} from './resolver';

/**
 * How a spoken name finds its agent. The cases come from the developer's report: "Atlas 3" going
 * to another Atlas, or to an agent that only mentions the name in its title or task.
 */
const ATLAS: RosterAgent = {
  id: 'atlas',
  name: 'Atlas',
  providerLabel: 'Claude',
  taskName: 'Fix login',
  projectName: 'chorus',
};
const ATLAS_2: RosterAgent = {
  id: 'atlas2',
  name: 'Atlas 2',
  providerLabel: 'Codex',
  taskName: 'Billing export',
  projectName: 'chorus',
};
/** Its window is closed: still addressable, like a finished agent that was put away. */
const ATLAS_3: RosterAgent = {
  id: 'atlas3',
  name: 'Atlas 3',
  providerLabel: 'Claude',
  taskName: 'Docs site',
  projectName: 'website',
  hidden: true,
};
/** Named Kilo 3 on the canvas, titled "Vesper 3" where it was started, on a task "Vesper 2". */
const KILO_3: RosterAgent = {
  id: 'kilo3',
  name: 'Kilo 3',
  providerLabel: 'Claude',
  taskName: 'Vesper 2',
  projectName: 'chorus',
  title: 'Vesper 3',
};
const JASPER_3: RosterAgent = {
  id: 'jasper3',
  name: 'Jasper 3',
  providerLabel: 'Gemini',
  taskName: 'Review atlas naming',
  projectName: 'website',
};
const fleet = [ATLAS, ATLAS_2, ATLAS_3, KILO_3, JASPER_3];

const idOf = (reference: string, roster: readonly RosterAgent[] = fleet) => {
  const resolution = resolveAgent(reference, roster, null);
  return resolution.kind === 'match' ? resolution.agent.id : resolution.kind;
};

describe('exact names', () => {
  it('resolves a name to the one agent that has it', () => {
    expect(idOf('Atlas')).toBe('atlas');
    expect(idOf('Atlas 2')).toBe('atlas2');
    expect(idOf('Jasper 3')).toBe('jasper3');
    expect(resolveAgent('Atlas 2', fleet, null)).toEqual({ kind: 'match', agent: ATLAS_2 });
  });

  it('ignores case, spacing, punctuation, and how the number was written', () => {
    for (const said of ['atlas 2', 'ATLAS  2', 'Atlas-2', 'Atlas 2.', 'atlas two', 'Atlas2']) {
      expect(idOf(said), said).toBe('atlas2');
    }
    expect(idOf("Atlas 2's window")).toBe('atlas2');
    expect(idOf('the Jasper 3 terminal')).toBe('jasper3');
  });

  it('reads "one" as the name that carries no number', () => {
    expect(idOf('Atlas one')).toBe('atlas');
    expect(idOf('Atlas 1')).toBe('atlas');
  });
});

describe('numbers', () => {
  it('never swaps one number for another or drops it', () => {
    const open = [ATLAS, ATLAS_2, KILO_3, JASPER_3];
    // Atlas 3 is archived: the instruction must not land on Atlas or Atlas 2.
    expect(idOf('Atlas 3', open)).toBe('none');
    expect(idOf('Atlas 4', open)).toBe('none');
    expect(idOf('Jasper 2', open)).toBe('none');
    expect(idOf('Jasper', [ATLAS, ATLAS_2])).toBe('none');
  });

  it('finds a closed agent by its exact name before any open agent that resembles it', () => {
    // Atlas is open and one letter away; a task and a title mention the name too.
    const roster = [
      ATLAS,
      ATLAS_3,
      { ...JASPER_3, taskName: 'Atlas 3', title: 'Atlas 3' },
      { ...KILO_3, taskName: 'Continue what Atlas 3 started' },
    ];
    expect(resolveAgent('Atlas 3', roster, null)).toEqual({ kind: 'match', agent: ATLAS_3 });
    expect(idOf('Atlas three', roster)).toBe('atlas3');
  });

  it('takes a name without its number when only one agent has that name', () => {
    expect(resolveAgent('Jasper', fleet, null)).toEqual({ kind: 'match', agent: JASPER_3 });
    expect(idOf('Kilo')).toBe('kilo3');
    // The plain Atlas exists, so "Atlas" is that agent and nobody else.
    expect(idOf('Atlas')).toBe('atlas');
  });

  it('asks when the name without a number could be two agents', () => {
    const open = [ATLAS_2, { ...ATLAS_3, hidden: undefined }];
    const resolution = resolveAgent('Atlas', open, null);
    expect(resolution.kind).toBe('ambiguous');
    expect(resolution.kind === 'ambiguous' && resolution.candidates.map((a) => a.id)).toEqual([
      'atlas2',
      'atlas3',
    ]);
    // A closed one does not make the open one ambiguous.
    expect(idOf('Atlas', [ATLAS_2, ATLAS_3])).toBe('atlas2');
  });
});

describe('words that sound like numbers', () => {
  it('reads "too" and "for" as words when that names an agent', () => {
    // No Atlas 2 or Atlas 4 here: "too" is "as well", "for" starts what is asked.
    expect(idOf('Atlas too', [ATLAS, JASPER_3])).toBe('atlas');
    expect(idOf('Atlas for', [ATLAS, JASPER_3])).toBe('atlas');
    expect(idOf('Jasper 3 too', [ATLAS, JASPER_3])).toBe('jasper3');
  });

  it('reads them as the number when only that names an agent', () => {
    expect(idOf('Atlas too', [ATLAS_2, JASPER_3])).toBe('atlas2');
    expect(idOf('Atlas to', [ATLAS_2, { ...ATLAS_3, hidden: undefined }])).toBe('atlas2');
  });

  it('asks when both readings name an agent, open or closed', () => {
    const atlas4: RosterAgent = { ...ATLAS_3, id: 'atlas4', name: 'Atlas 4' };
    for (const [said, roster] of [
      ['Atlas too', [ATLAS, { ...ATLAS_2, hidden: true }]],
      ['Atlas for', [ATLAS, atlas4]],
    ] as const) {
      const resolution = resolveAgent(said, roster, null);
      expect(resolution.kind, said).toBe('ambiguous');
      expect(resolution.kind === 'ambiguous' && resolution.candidates).toEqual(roster);
    }
  });
});

describe('names the developer chose', () => {
  const reviewer: RosterAgent = {
    id: 'reviewer',
    name: 'GPT 5 reviewer',
    providerLabel: 'Codex',
    taskName: 'Review',
  };
  const backend: RosterAgent = { ...reviewer, id: 'backend', name: 'Backend' };

  it('finds them by name, and without a number inside the name', () => {
    expect(idOf('Backend', [reviewer, backend])).toBe('backend');
    expect(idOf('GPT 5 reviewer', [reviewer, backend])).toBe('reviewer');
    expect(idOf('GPT reviewer', [reviewer, backend])).toBe('reviewer');
    expect(idOf('GPT 4 reviewer', [reviewer, backend])).toBe('none');
  });

  it("asks when a word is one agent's name and another agent's provider", () => {
    const kilo2: RosterAgent = { ...ATLAS_2, id: 'kilo2', name: 'Kilo 2', providerLabel: 'Claude' };
    const kiloCode: RosterAgent = { ...ATLAS, id: 'kc', name: 'Bravo', providerLabel: 'Kilo' };
    expect(resolveAgent('the Kilo agent', [kilo2, kiloCode], null).kind).toBe('ambiguous');
    // Its full name is still that agent alone.
    expect(idOf('Kilo 2', [kilo2, kiloCode])).toBe('kilo2');
  });
});

describe('a name inside a project', () => {
  it("reaches a closed agent by its own name before an open one's name without the number", () => {
    const closedAtlas: RosterAgent = { ...ATLAS, hidden: true };
    expect(idOf('Atlas in chorus', [closedAtlas, ATLAS_2])).toBe('atlas');
    expect(idOf('Atlas 2 in chorus', [closedAtlas, ATLAS_2])).toBe('atlas2');
    expect(idOf('Atlas in website', [closedAtlas, ATLAS_2])).toBe('none');
  });
});

describe('speech-to-text variants', () => {
  it('matches a misheard name, marked as a near match', () => {
    expect(resolveAgent('at less', fleet, null)).toEqual({
      kind: 'match',
      agent: ATLAS,
      fuzzy: true,
    });
    expect(idOf('at las')).toBe('atlas');
    expect(idOf('Casper 3')).toBe('jasper3');
    expect(idOf('kilo three')).toBe('kilo3');
  });

  it('keeps the number that was heard', () => {
    expect(idOf('at less 2')).toBe('atlas2');
    expect(idOf('at less three')).toBe('atlas3');
    // "At less 5" is nobody: the near spelling does not excuse the wrong number.
    expect(idOf('at less 5')).toBe('none');
  });

  it('reaches a numbered name from a misheard word when no number was said', () => {
    expect(idOf('jazz per', [JASPER_3, KILO_3])).toBe('jasper3');
    expect(idOf('jasber', [JASPER_3, KILO_3])).toBe('jasper3');
    expect(resolveAgent('jasber', [JASPER_3, KILO_3], null)).toMatchObject({ fuzzy: true });
    // With a plain Atlas present, "at less" is that one, not Atlas 2 or Atlas 3.
    expect(idOf('at less', [ATLAS_2, ATLAS, ATLAS_3])).toBe('atlas');
  });
});

describe('duplicate names', () => {
  const chorusAtlas = ATLAS;
  const websiteAtlas: RosterAgent = { ...ATLAS, id: 'atlas-web', projectName: 'website' };

  it('asks which one, telling them apart by project', () => {
    const resolution = resolveAgent('Atlas', [chorusAtlas, websiteAtlas], null);
    expect(resolution.kind).toBe('ambiguous');
    expect(candidateLabels([chorusAtlas, websiteAtlas])).toEqual([
      'Atlas in chorus',
      'Atlas in website',
    ]);
    // The answer to that question resolves.
    expect(idOf('Atlas in website', [chorusAtlas, websiteAtlas])).toBe('atlas-web');
    expect(idOf('Atlas in chorus', [chorusAtlas, websiteAtlas])).toBe('atlas');
  });

  it('tells two of a project apart by task, and leaves distinct names alone', () => {
    const twin: RosterAgent = { ...ATLAS, id: 'twin', taskName: 'Fix logout' };
    expect(candidateLabels([ATLAS, twin, JASPER_3])).toEqual([
      'Atlas on "Fix login"',
      'Atlas on "Fix logout"',
      'Jasper 3',
    ]);
  });

  it('prefers the one whose window is open', () => {
    expect(idOf('Atlas', [{ ...websiteAtlas, hidden: true }, chorusAtlas])).toBe('atlas');
  });
});

describe('alternate titles', () => {
  it('resolves a title or task name that one agent alone goes by', () => {
    expect(idOf('Vesper 3')).toBe('kilo3');
    expect(idOf('Vesper 2')).toBe('kilo3');
    expect(idOf('vesper three')).toBe('kilo3');
  });

  it("never lets a title or task shadow another agent's real name", () => {
    const vesper3: RosterAgent = {
      id: 'vesper3',
      name: 'Vesper 3',
      providerLabel: 'Codex',
      taskName: 'Deploy',
      projectName: 'website',
      hidden: true,
    };
    const vesper2: RosterAgent = { ...vesper3, id: 'vesper2', name: 'Vesper 2' };
    // Kilo 3 is open and titled "Vesper 3" on a task "Vesper 2"; the real ones are closed.
    expect(idOf('Vesper 3', [KILO_3, vesper3, vesper2])).toBe('vesper3');
    expect(idOf('Vesper 2', [KILO_3, vesper3, vesper2])).toBe('vesper2');
    // "Vesper" is the agents named Vesper, not the one that only carries the word.
    expect(resolveAgent('Vesper', [KILO_3, vesper3, vesper2], null).kind).toBe('ambiguous');
  });

  it('asks when a title and a task point at different agents', () => {
    const other: RosterAgent = { ...JASPER_3, title: 'Vesper 2' };
    expect(resolveAgent('Vesper 2', [KILO_3, other], null).kind).toBe('ambiguous');
  });

  it('does not treat a title several agents share as a name', () => {
    const shared = [ATLAS_2, JASPER_3].map((agent) => ({ ...agent, title: 'Bravo' }));
    expect(idOf('Bravo', shared)).toBe('none');
  });
});

describe('closed, finished, and archived agents', () => {
  it('keeps a closed agent addressable by name', () => {
    expect(idOf('Atlas 3')).toBe('atlas3');
    expect(idOf('Atlas 3 in website')).toBe('atlas3');
  });

  it('resolves a finished agent like any other: status is not part of a name', () => {
    // A finished agent stays on the roster until it is archived.
    expect(idOf('Jasper 3', [JASPER_3])).toBe('jasper3');
  });

  it('matches nobody once the agent is archived, and says who is near', () => {
    const open = [ATLAS, ATLAS_2, KILO_3, JASPER_3];
    expect(idOf('Atlas 3', open)).toBe('none');
    expect(similarAgents('Atlas 3', open).map((agent) => agent.name)).toEqual(['Atlas', 'Atlas 2']);
    expect(similarAgents('Casper', open).map((agent) => agent.name)).toEqual(['Jasper 3']);
    expect(similarAgents('Zulu 2', open)).toEqual([]);
  });
});

describe('no match', () => {
  it('returns none instead of the focused agent or a lookalike', () => {
    expect(resolveAgent('Zulu', fleet, 'atlas').kind).toBe('none');
    expect(resolveAgent('Bravo 2', fleet, 'atlas').kind).toBe('none');
    expect(resolveAgent('banana', fleet, 'atlas').kind).toBe('none');
  });

  it('never reads an agent name as part of a task name', () => {
    // Jasper 3 works on "Review atlas naming"; that does not make it Atlas.
    expect(idOf('Atlas', [JASPER_3, KILO_3])).toBe('none');
    expect(idOf('Vesper', [JASPER_3, KILO_3])).toBe('none');
    // A description of the task still works.
    expect(idOf('the naming agent', [JASPER_3, KILO_3])).toBe('jasper3');
  });
});

describe('unknownSpokenNames', () => {
  it('finds numbered names no agent has', () => {
    expect(unknownSpokenNames('Tell Atlas 4 to run the tests.', fleet)).toEqual(['Atlas 4']);
    expect(unknownSpokenNames('ask echo two for status', fleet)).toEqual(['Echo 2']);
    expect(unknownSpokenNames('send that to Atlas4', fleet)).toEqual(['Atlas 4']);
    expect(unknownSpokenNames('Bravo 2, rebase onto main', fleet)).toEqual(['Bravo 2']);
  });

  it('accepts names, titles, and task names that exist, open or closed', () => {
    expect(unknownSpokenNames('tell atlas three to rebase', fleet)).toEqual([]);
    expect(unknownSpokenNames('what is Vesper 3 doing, and Vesper 2?', fleet)).toEqual([]);
  });

  it('leaves ordinary speech alone', () => {
    expect(unknownSpokenNames('echo to the console and wait for 2 seconds', fleet)).toEqual([]);
    expect(unknownSpokenNames('tell Atlas to run the tests', fleet)).toEqual([]);
    expect(unknownSpokenNames('the pilot one is fine', fleet)).toEqual([]);
    // A thing with a number in it, a clause about an agent, and a count.
    expect(unknownSpokenNames('run the Delta 2 migration again', fleet)).toEqual([]);
    expect(unknownSpokenNames('tell this one that Atlas 4 was archived', fleet)).toEqual([]);
    expect(unknownSpokenNames('tell Atlas two things: first, rebase', fleet)).toEqual([]);
  });
});

describe('substitutionRefusal', () => {
  it('refuses another agent in place of a name nobody has', () => {
    const open = [ATLAS, ATLAS_2, KILO_3];
    const said = 'Tell Atlas 3 to run the tests';
    for (const target of open) {
      const refusal = substitutionRefusal(said, target, open);
      expect(refusal, target.name).toContain('"Atlas 3"');
      expect(refusal).toContain('closest: Atlas, Atlas 2');
    }
  });

  it('allows the agent the developer did name', () => {
    expect(substitutionRefusal('tell Atlas 2 that Atlas 4 is gone', ATLAS_2, fleet)).toBeNull();
    expect(substitutionRefusal('tell Vesper 3 that Atlas 4 is gone', KILO_3, fleet)).toBeNull();
    expect(substitutionRefusal('tell Atlas, not Atlas 4, to stop', ATLAS, fleet)).toBeNull();
  });

  it('says nothing when no agent was named, or the one named is the target', () => {
    expect(substitutionRefusal('run the tests again', ATLAS, fleet)).toBeNull();
    expect(substitutionRefusal('tell Atlas 3 to rebase', ATLAS_3, fleet)).toBeNull();
    expect(substitutionRefusal('tell atlas three to rebase', ATLAS_3, fleet)).toBeNull();
  });

  it('refuses the agent whose name differs only by the number', () => {
    // Atlas 3 exists and was named; the action is headed for Atlas or Atlas 2.
    for (const target of [ATLAS, ATLAS_2]) {
      const refusal = substitutionRefusal('tell Atlas 3 to rebase', target, fleet);
      expect(refusal, target.name).toContain('"Atlas 3"');
      expect(refusal).toContain(`a different agent from ${target.name}`);
    }
    // The other way round: "Atlas" was said, and it is not Atlas 3.
    expect(substitutionRefusal('tell Atlas to rebase', ATLAS_3, fleet)).toContain('"Atlas"');
  });

  it('counts every way of talking to an agent', () => {
    for (const said of [
      'Atlas 3, rebase onto main',
      'Hey Maestro, can you ask Atlas 3 to rebase',
      'No, send that to Atlas 3',
      'send Atlas 3 the diff',
      'get Atlas 3 to rebase',
      'I want Atlas 3 to run the tests',
      'tell Atlas 3 and Jasper 3 to stop',
      'send that to Atlas 3',
      'send that to Atlas 3 instead please',
      "what's Atlas 3 doing",
      'what is Atlas 3 doing',
      'is Atlas 3 done',
      'focus on Atlas 3',
      'stop Atlas 3',
    ]) {
      expect(substitutionRefusal(said, ATLAS, fleet), said).toContain('"Atlas 3"');
    }
    // A plain word opening the utterance is a name when the comma says so.
    expect(substitutionRefusal('Atlas, rebase onto main', ATLAS_3, fleet)).toContain('"Atlas"');
  });

  it('lets a name that is only mentioned pass', () => {
    // Atlas is focused; Atlas 3 is context, not who the command is for.
    for (const said of [
      "tell it to rebase onto Atlas 3's branch",
      'do the same thing Atlas 3 did',
      'tell this one what Atlas 3 found',
      'send it to the focused agent, like Atlas 3 did',
      'see what Atlas 3 changed and do the opposite',
      'compare it to Atlas 3 and report back',
      'Atlas 3 is done, so rebase this one',
      'tell it to compare its results to Atlas 3',
      'tell it to ask Atlas 3 for the schema',
    ]) {
      expect(substitutionRefusal(said, ATLAS, fleet), said).toBeNull();
    }
    // Both were named; either can be the target.
    expect(substitutionRefusal('tell Atlas what Atlas 3 found', ATLAS, fleet)).toBeNull();
    // "Atlas two things" is Atlas and a count, even beside an Atlas 2.
    expect(substitutionRefusal('tell Atlas two things: first, rebase', ATLAS, fleet)).toBeNull();
    // A different word altogether is the model's call, as before.
    expect(substitutionRefusal('tell Atlas 3 to rebase', JASPER_3, fleet)).toBeNull();
  });
});

describe('names an agent had until a rename', () => {
  // "Atlas 3" was renamed to Backend a moment ago.
  const backend: RosterAgent = {
    ...ATLAS_3,
    id: 'backend',
    name: 'Backend',
    formerly: ['Atlas 3'],
  };

  it('still reach the agent', () => {
    expect(idOf('Atlas 3', [ATLAS, backend])).toBe('backend');
    expect(idOf('atlas three', [ATLAS, backend])).toBe('backend');
    expect(unknownSpokenNames('tell Atlas 3 to rebase', [ATLAS, backend])).toEqual([]);
    expect(substitutionRefusal('tell Atlas 3 to rebase', backend, [ATLAS, backend])).toBeNull();
  });

  it('lose to an agent that has the name now', () => {
    const newAtlas3: RosterAgent = { ...ATLAS_3, id: 'new', hidden: true };
    expect(idOf('Atlas 3', [backend, newAtlas3])).toBe('new');
  });
});

describe('agents that left a moment ago', () => {
  /** Jasper 3 works on the backend; an agent called Backend was archived, and so was Bravo. */
  const roster = Object.assign([ATLAS, { ...JASPER_3, taskName: 'Backend refactor' }], {
    departed: ['Backend', 'Bravo'],
  });

  it('are not mistaken for an agent whose task says the same word', () => {
    expect(idOf('Backend', roster)).toBe('none');
    expect(departedName('Backend', roster)).toBe('Backend');
    // Described rather than named, it is the agent on that task.
    expect(idOf('the backend agent', roster)).toBe('jasper3');
    expect(idOf('the refactor agent', roster)).toBe('jasper3');
  });

  it('are names nobody has, so nothing else takes their place', () => {
    expect(unknownSpokenNames('tell Bravo to run the tests', roster)).toEqual(['Bravo']);
    expect(unknownSpokenNames('send that to Backend', roster)).toEqual(['Backend']);
    expect(unknownSpokenNames('Bravo, run the tests', roster)).toEqual(['Bravo']);
    expect(substitutionRefusal('tell Bravo to run the tests', ATLAS, roster)).toContain('"Bravo"');
    expect(unknownSpokenNames('tell Bravo 2 to run the tests', roster)).toEqual(['Bravo 2']);
  });

  it('are ordinary words wherever the developer is not talking to them', () => {
    const gone = Object.assign([ATLAS], { departed: ['Echo', 'Backend', 'Delta'] });
    for (const said of [
      'echo the path to the console',
      'restart backend and rerun the tests',
      'ask the backend agent for a status',
      'what is the delta between the two branches',
      "use Echo's branch as the base",
      'tell it to open backend logs',
      'tell it to stop echo from printing twice',
      'tell it to write the result to delta',
      // A number after an ordinary word is not an agent either.
      'tell it to echo 42 to stdout',
      'tell it to upgrade to Quartz 2',
      'run the Delta 2 migration again',
    ]) {
      expect(unknownSpokenNames(said, gone), said).toEqual([]);
      expect(substitutionRefusal(said, ATLAS, gone), said).toBeNull();
    }
  });

  it('do not shadow an agent that answers to the same name', () => {
    // An agent titled "Backend" is still here: the word is its second name, not the one that left.
    const titled = Object.assign([{ ...ATLAS, title: 'Backend' }], { departed: ['Backend'] });
    expect(departedName('Backend', titled)).toBeNull();
    expect(idOf('Backend', titled)).toBe('atlas');
    expect(unknownSpokenNames('tell Backend to run the tests', titled)).toEqual([]);
  });

  it('stop counting once another agent takes the name', () => {
    const reused = Object.assign([...roster, { ...ATLAS_2, id: 'bravo', name: 'Bravo' }], {
      departed: roster.departed,
    });
    expect(idOf('Bravo', reused)).toBe('bravo');
    expect(departedName('Bravo', reused)).toBeNull();
    expect(unknownSpokenNames('tell Bravo to run the tests', reused)).toEqual([]);
  });
});
