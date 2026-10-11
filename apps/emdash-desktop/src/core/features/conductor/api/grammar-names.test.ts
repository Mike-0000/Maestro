import { describe, expect, it } from 'vitest';
import { resolveCanvasRef, type CanvasRefContext } from './canvas-refs';
import { parseCommand } from './grammar';
import type { RosterAgent } from './resolver';

/** Instant commands addressed by name: the right agent, a question, or the model. Never a guess. */
const atlas: RosterAgent = { id: 'atlas', name: 'Atlas', providerLabel: 'Claude', taskName: 'one' };
const atlas2: RosterAgent = { ...atlas, id: 'atlas2', name: 'Atlas 2', taskName: 'two' };
const atlas3: RosterAgent = { ...atlas, id: 'atlas3', name: 'Atlas 3', taskName: 'three' };
const kilo3: RosterAgent = {
  id: 'kilo3',
  name: 'Kilo 3',
  providerLabel: 'Codex',
  taskName: 'Vesper 2',
  title: 'Vesper 3',
};

describe('commands addressed by name', () => {
  it('sends to the numbered agent that was named', () => {
    const roster = [atlas, atlas2, atlas3, kilo3];
    expect(parseCommand('Tell Atlas 3 to run the tests', roster, 'atlas')).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas3' },
      text: 'run the tests',
    });
    expect(parseCommand('tell atlas three to run the tests', roster, 'atlas')).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas3' },
      text: 'run the tests',
    });
    expect(parseCommand('Tell Atlas to run the tests', roster, 'atlas3')).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas' },
    });
  });

  it('reaches a closed agent by name instead of the open one that resembles it', () => {
    const roster = [atlas, { ...atlas3, hidden: true }];
    expect(parseCommand('Tell Atlas 3 to run the tests', roster, 'atlas')).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas3' },
    });
    expect(parseCommand('Stop Atlas 3', roster, 'atlas')).toMatchObject({
      kind: 'interrupt',
      agent: { id: 'atlas3' },
    });
  });

  it('never sends a name nobody has to another agent or the focused one', () => {
    const roster = [atlas, atlas2, kilo3];
    // Atlas 3 is archived. The model takes it from here and asks.
    expect(parseCommand('Tell Atlas 3 to run the tests', roster, 'atlas')).toBeNull();
    expect(parseCommand('Atlas 3, run the tests', roster, 'atlas')).toBeNull();
    expect(parseCommand('Focus Atlas 3', roster, 'atlas')).toBeNull();
    expect(parseCommand('Stop Atlas 3', roster, 'atlas')).toBeNull();
    expect(parseCommand('Close Atlas 3', roster, 'atlas')).toBeNull();
    expect(parseCommand('Archive Atlas 3', roster, 'atlas')).toBeNull();
  });

  it('asks which one when a name could be two agents', () => {
    expect(parseCommand('Focus Atlas', [atlas2, atlas3], null)).toEqual({
      kind: 'clarify',
      question: 'Which one: Atlas 2 or Atlas 3?',
    });
    const twins = [
      { ...atlas, projectName: 'chorus' },
      { ...atlas, id: 'web', projectName: 'website' },
    ];
    expect(parseCommand('Tell Atlas to run the tests', twins, null)).toEqual({
      kind: 'clarify',
      question: 'Which one: Atlas in chorus or Atlas in website?',
    });
    expect(parseCommand('Tell Atlas in website to run the tests', twins, null)).toMatchObject({
      kind: 'send',
      agent: { id: 'web' },
      text: 'run the tests',
    });
  });

  it('does not read "too" or "for" as a number when the plain name is an agent', () => {
    const atlas4: RosterAgent = { ...atlas, id: 'atlas4', name: 'Atlas 4', taskName: 'four' };
    expect(parseCommand('Stop Atlas too', [atlas, kilo3], null)).toMatchObject({
      kind: 'interrupt',
      agent: { id: 'atlas' },
    });
    expect(parseCommand('Ask Atlas for a status update', [atlas, kilo3], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas' },
      text: 'a status update',
    });
    expect(parseCommand('Tell Atlas to run the tests', [atlas, atlas2], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas' },
      text: 'run the tests',
    });
    // With an Atlas 2 put away, "Atlas too" alone could mean either: ask.
    expect(parseCommand('Stop Atlas too', [atlas, { ...atlas2, hidden: true }], null)).toEqual({
      kind: 'clarify',
      question: 'Which one: Atlas or Atlas 2?',
    });
    // With a message after it, "for" starts the message, even beside an Atlas 4.
    expect(parseCommand('Ask Atlas for a status update', [atlas, atlas4], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas' },
      text: 'for a status update',
    });
    expect(parseCommand('Ask Atlas 4 for a status update', [atlas, atlas4], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas4' },
    });
  });

  it('asks when a word that sounds like a number comes right before "to"', () => {
    const atlas4: RosterAgent = { ...atlas, id: 'atlas4', name: 'Atlas 4', taskName: 'four' };
    // "Atlas tree to run" is "Atlas three" misheard, or Atlas: never "tree to run…" sent to Atlas.
    expect(parseCommand('Tell Atlas tree to run the tests', [atlas, atlas3], null)).toEqual({
      kind: 'clarify',
      question: 'Which one: Atlas or Atlas 3?',
    });
    expect(parseCommand('Tell Atlas for to run the tests', [atlas, atlas4], null)).toEqual({
      kind: 'clarify',
      question: 'Which one: Atlas or Atlas 4?',
    });
    // Only one of them exists: that one, with the message intact.
    expect(parseCommand('Tell Atlas tree to run the tests', [atlas3, kilo3], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas3' },
      text: 'run the tests',
    });
  });

  it('asks about "too" between a name and its message when it could be the number', () => {
    for (const said of ['Tell Atlas too to run the tests', 'Ask Atlas too for a status update']) {
      expect(parseCommand(said, [atlas, atlas2], null), said).toEqual({
        kind: 'clarify',
        question: 'Which one: Atlas or Atlas 2?',
      });
    }
    // No Atlas 2: "too" is "as well", and the message starts after it.
    expect(parseCommand('Tell Atlas too to run the tests', [atlas, kilo3], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas' },
      text: 'run the tests',
    });
    expect(parseCommand('Ask Atlas too for a status update', [atlas, kilo3], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas' },
      text: 'a status update',
    });
    // No plain Atlas: it can only be Atlas 2.
    expect(parseCommand('Tell Atlas too to run the tests', [atlas2, kilo3], null)).toMatchObject({
      kind: 'send',
      agent: { id: 'atlas2' },
      text: 'run the tests',
    });
  });

  it('takes the numbers off the names on request', () => {
    for (const said of [
      'Simplify the agent names',
      'simplify agent names.',
      'Can you drop the numbers from the names',
      'remove the numbers from all the agent names',
      "Take the numbers off the agents' names please",
      'strip the numbers from the names of the agents',
    ]) {
      expect(parseCommand(said, [atlas, kilo3], null), said).toEqual({ kind: 'simplifyNames' });
    }
  });

  it('renames nothing on wording that could mean something else', () => {
    // Several agents would change name at once: anything vaguer goes to the model.
    for (const said of [
      'fix the names',
      'clean up the names',
      'shorten the names',
      'simplify the names',
      'remove the numbers',
      'drop the numbers',
      'remove the numbers agent',
      'simplify the code',
    ]) {
      expect(parseCommand(said, [atlas, kilo3], null), said).toBeNull();
    }
    // Still a window command.
    expect(parseCommand('remove Atlas', [atlas, kilo3], null)).toMatchObject({ kind: 'close' });
  });

  it('follows another title to its agent, and a real name past the title', () => {
    expect(parseCommand('Focus Vesper 3', [atlas, kilo3], null)).toMatchObject({
      kind: 'focus',
      agent: { id: 'kilo3' },
    });
    const vesper3: RosterAgent = { ...atlas, id: 'vesper3', name: 'Vesper 3', hidden: true };
    expect(parseCommand('Focus Vesper 3', [atlas, kilo3, vesper3], null)).toMatchObject({
      kind: 'focus',
      agent: { id: 'vesper3' },
    });
  });
});

describe('canvas commands addressed by name', () => {
  const windows: CanvasRefContext = {
    entities: [
      { id: 'agent:a', kind: 'agent', name: 'Atlas', providerLabel: 'Claude', taskName: 'one' },
      {
        id: 'agent:j',
        kind: 'agent',
        name: 'Jasper 3',
        providerLabel: 'Codex',
        taskName: 'Backend refactor',
      },
    ],
    selection: [],
    focusedId: null,
    recent: [],
    currentRegion: null,
    onStage: false,
  };

  it('does not take an agent that just left for the one whose task says its name', () => {
    expect(resolveCanvasRef('Backend', windows)).toEqual({ kind: 'match', ids: ['agent:j'] });
    const after = { ...windows, departedAgents: ['Backend'] };
    expect(resolveCanvasRef('Backend', after)).toEqual({ kind: 'none' });
    expect(resolveCanvasRef('the backend agent', after)).toEqual({
      kind: 'match',
      ids: ['agent:j'],
    });
  });
});
