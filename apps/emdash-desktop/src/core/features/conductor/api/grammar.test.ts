import { describe, expect, it } from 'vitest';
import { chooseMode, parseCommand, type GrammarCommand } from './grammar';
import type { RosterAgent } from './resolver';

const roster: RosterAgent[] = [
  { id: 'c1', name: 'Claude 1', providerLabel: 'Claude', taskName: 'auth-refactor' },
  { id: 'c2', name: 'Claude 2', providerLabel: 'Claude', taskName: 'settings-page' },
  { id: 'x1', name: 'Codex 1', providerLabel: 'Codex', taskName: 'api-tests' },
  { id: 'g1', name: 'Gemini 1', providerLabel: 'Gemini', taskName: 'docs' },
];

type Expected =
  | null
  | { kind: Exclude<GrammarCommand['kind'], 'focus' | 'interrupt' | 'status' | 'send' | 'note'> }
  | { kind: 'focus' | 'interrupt' | 'status'; agent: string }
  | { kind: 'send'; agent: string; text: string }
  | { kind: 'note'; text: string };

/**
 * Routing eval (docs/chorus/PLAN.md §9.3). Each row is a realistic transcript: fillers, casing and
 * punctuation from the recognizer, misheard names, and the "to"/"two" homophone.
 */
const cases: [utterance: string, focused: string | null, expected: Expected][] = [
  // Confirm / reject
  ['Yes.', null, { kind: 'confirm' }],
  ['yeah', null, { kind: 'confirm' }],
  ['Go ahead', null, { kind: 'confirm' }],
  ['Approve.', null, { kind: 'confirm' }],
  ['okay, do it', null, { kind: 'confirm' }],
  ['No.', null, { kind: 'reject' }],
  ['Cancel', null, { kind: 'reject' }],
  ['never mind', null, { kind: 'reject' }],
  ['Deny.', null, { kind: 'reject' }],
  // Navigation
  ['Next.', null, { kind: 'next' }],
  ["What's next?", null, { kind: 'next' }],
  ['who needs me', null, { kind: 'next' }],
  ['Show me everything.', null, { kind: 'overview' }],
  ['Zoom out.', null, { kind: 'overview' }],
  ['overview please', null, { kind: 'overview' }],
  ['Focus Claude 2.', null, { kind: 'focus', agent: 'c2' }],
  ['go to clod two', null, { kind: 'focus', agent: 'c2' }],
  ['Show me Codex.', null, { kind: 'focus', agent: 'x1' }],
  ['switch to the docs agent', null, { kind: 'focus', agent: 'g1' }],
  ['Jump to Gemini', null, { kind: 'focus', agent: 'g1' }],
  ['open codecs one', null, { kind: 'focus', agent: 'x1' }],
  ['zoom in on Claude one', null, { kind: 'focus', agent: 'c1' }],
  // Interrupt
  ['Stop Codex.', null, { kind: 'interrupt', agent: 'x1' }],
  ['interrupt claude two', null, { kind: 'interrupt', agent: 'c2' }],
  ['stop this one', 'c1', { kind: 'interrupt', agent: 'c1' }],
  // Status
  ["What's Codex doing?", null, { kind: 'status', agent: 'x1' }],
  ['how is Claude 1 doing', null, { kind: 'status', agent: 'c1' }],
  ['Is Gemini done?', null, { kind: 'status', agent: 'g1' }],
  ['status of the auth agent', null, { kind: 'status', agent: 'c1' }],
  // Send (tell / ask)
  ['Tell Codex to run the tests.', null, { kind: 'send', agent: 'x1', text: 'run the tests' }],
  [
    'Ask Codex, is there anything left before manufacture?',
    null,
    { kind: 'send', agent: 'x1', text: 'is there anything left before manufacture?' },
  ],
  [
    'tell Claude 2 to add a dark mode toggle',
    null,
    { kind: 'send', agent: 'c2', text: 'add a dark mode toggle' },
  ],
  [
    'Tell Claude two to fix the lint errors.',
    null,
    { kind: 'send', agent: 'c2', text: 'fix the lint errors' },
  ],
  [
    'ask Gemini to summarize the README',
    null,
    { kind: 'send', agent: 'g1', text: 'summarize the README' },
  ],
  ['tell this one to keep going', 'c1', { kind: 'send', agent: 'c1', text: 'keep going' }],
  [
    'Uh, tell codecs to commit its work',
    null,
    { kind: 'send', agent: 'x1', text: 'commit its work' },
  ],
  [
    'tell claude one that the API changed',
    null,
    { kind: 'send', agent: 'c1', text: 'the API changed' },
  ],
  [
    'Claude 2, use the existing theme tokens.',
    null,
    {
      kind: 'send',
      agent: 'c2',
      text: 'use the existing theme tokens',
    },
  ],
  [
    'Codex, write a test for the parser.',
    null,
    {
      kind: 'send',
      agent: 'x1',
      text: 'write a test for the parser',
    },
  ],
  // Dictation control, voice, notes
  ['Send it.', null, { kind: 'submit' }],
  ['submit', null, { kind: 'submit' }],
  ['Mute.', null, { kind: 'mute' }],
  ['unmute', null, { kind: 'unmute' }],
  [
    'Take a note: check the migration on staging',
    null,
    {
      kind: 'note',
      text: 'check the migration on staging',
    },
  ],
  // Ambiguity asks, never guesses
  ['tell Claude to run the tests', null, { kind: 'clarify' }],
  ['focus claude', null, { kind: 'clarify' }],
  // Goes to the LLM
  ['Build a settings page with dark mode and split it between Claude and Codex', null, null],
  ['what should I work on next week', null, null],
  ['refactor the auth module', null, null],
  ['stop the world', null, null],
  ['tell Claude 3 to deploy', null, null],
  ['Codex needs to be faster', null, null],
];

describe('parseCommand routing eval', () => {
  it.each(cases)('%s', (utterance, focused, expected) => {
    const command = parseCommand(utterance, roster, focused);
    if (expected === null) {
      expect(command).toBeNull();
      return;
    }
    expect(command?.kind).toBe(expected.kind);
    if (!command) return;
    if ('agent' in expected) {
      expect('agent' in command && command.agent?.id).toBe(expected.agent);
    }
    if ('text' in expected) {
      expect('text' in command && command.text).toBe(expected.text);
    }
  });

  it('keeps the original casing of the instruction text', () => {
    const command = parseCommand('Tell Codex to update README.md', roster, null);
    expect(command).toMatchObject({ kind: 'send', text: 'update README.md' });
  });
});

describe('chooseMode', () => {
  it.each([
    ['plan the auth rewrite across three agents', 'plan'],
    ['split this into parallel tasks', 'plan'],
    ['build a settings page with dark mode and keyboard shortcuts for the editor', 'plan'],
    ["let's implement OAuth login with GitHub and Google plus refresh tokens", 'plan'],
    ['tell codex to run the tests', 'command'],
    ['what is claude 2 doing', 'command'],
    ['add a note', 'command'],
    ['build it', 'command'],
  ] as const)('%s -> %s', (utterance, mode) => {
    expect(chooseMode(utterance)).toBe(mode);
  });
});

/** Transcripts from the developer's logs that used to lose the first words of the message. */
describe('messages keep their first words', () => {
  const named: RosterAgent[] = [
    { id: 'lima', name: 'Lima 3', providerLabel: 'Claude', taskName: 'Harder difficulty mode' },
    { id: 'atlas', name: 'Atlas 3', providerLabel: 'Claude', taskName: 'Redesign admin menus' },
    { id: 'oscar', name: 'Oscar 3', providerLabel: 'Claude', taskName: 'Skip mission 13' },
    { id: 'sparrow', name: 'Sparrow 3', providerLabel: 'Claude', taskName: 'Phone notifications' },
    { id: 'iris', name: 'Iris 2', providerLabel: 'Claude', taskName: 'make sure push works' },
  ];

  it.each([
    [
      'Ask Lima 3 how much more difficult are the modes now.',
      'lima',
      'how much more difficult are the modes now',
    ],
    [
      'Tell Atlas 3: see if anything in the latest update may have affected artillery.',
      'atlas',
      'see if anything in the latest update may have affected artillery',
    ],
    [
      'Tell Oscar 3 go ahead and push it to the X drive.',
      'oscar',
      'go ahead and push it to the X drive',
    ],
    [
      "Ask Sparrow 3 if I need to reinstall the PWA on my phone or if it'll work out of the box.",
      'sparrow',
      "if I need to reinstall the PWA on my phone or if it'll work out of the box",
    ],
    ['Tell at less three to run the tests', 'atlas', 'run the tests'],
  ])('%s', (utterance, agent, text) => {
    expect(parseCommand(utterance, named, null)).toMatchObject({
      kind: 'send',
      agent: { id: agent },
      text,
    });
  });

  it('does not take an opening clause for an agent because a task contains the word', () => {
    expect(
      parseCommand('Sure, please provide the audio you would like me to transcribe.', named, null)
    ).toBeNull();
    expect(parseCommand('Iris 2, run the tests', named, null)).toMatchObject({
      kind: 'send',
      agent: { id: 'iris' },
    });
  });
});

describe('project scopes stay out of the message', () => {
  const HOUR = 3_600_000;
  const scoped: RosterAgent[] = [
    {
      id: 'atlas',
      name: 'Atlas',
      providerLabel: 'Claude',
      taskName: 'menus',
      projectName: 'ace',
      createdAt: HOUR,
    },
    {
      id: 'bravo',
      name: 'Bravo',
      providerLabel: 'Claude',
      taskName: 'voice',
      projectName: 'chorus',
      createdAt: 2 * HOUR,
    },
    {
      id: 'echo',
      name: 'Echo',
      providerLabel: 'Codex',
      taskName: 'forecast',
      projectName: 'weather-app',
      createdAt: 3 * HOUR,
    },
  ];

  it('sends to the latest agent of the named project', () => {
    expect(
      parseCommand('Tell the latest agent in the chorus project to run the tests', scoped, null)
    ).toMatchObject({ kind: 'send', agent: { id: 'bravo' }, text: 'run the tests' });
    expect(parseCommand('Tell Bravo in chorus to run the tests', scoped, null)).toMatchObject({
      kind: 'send',
      agent: { id: 'bravo' },
      text: 'run the tests',
    });
  });

  it('leaves a name that is not in the named project to the model', () => {
    expect(parseCommand('Ask Atlas in chorus to run the tests', scoped, null)).toBeNull();
  });

  it('keeps the most of the message when the name itself was misheard', () => {
    const named: RosterAgent[] = [
      { id: 'lima', name: 'Lima 3', providerLabel: 'Claude', taskName: 'difficulty' },
    ];
    expect(parseCommand('Ask Lema 3 how much more difficult is it', named, null)).toMatchObject({
      kind: 'send',
      agent: { id: 'lima' },
      text: 'how much more difficult is it',
    });
    expect(
      parseCommand(
        'Sure, I can help with that.',
        [{ id: 'sora', name: 'Sora', providerLabel: 'Claude', taskName: 'video' }],
        null
      )
    ).toBeNull();
  });
});
