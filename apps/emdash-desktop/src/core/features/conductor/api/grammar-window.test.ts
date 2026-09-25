import { describe, expect, it } from 'vitest';
import { parseCommand, type GrammarCommand } from './grammar';
import type { RosterAgent } from './resolver';

const roster: RosterAgent[] = [
  { id: 'a', name: 'Atlas', providerLabel: 'Claude', taskName: 'auth-refactor' },
  { id: 'b', name: 'Bravo', providerLabel: 'Codex', taskName: 'api-tests' },
  { id: 'c', name: 'Cedar', providerLabel: 'Gemini', taskName: 'docs', hidden: true },
];

function parse(utterance: string, focused: string | null = null): GrammarCommand | null {
  return parseCommand(utterance, roster, focused);
}

function agentOf(command: GrammarCommand | null): string | null | undefined {
  if (!command) return undefined;
  if ('agent' in command) return command.agent?.id ?? null;
  if (command.kind === 'reopen') {
    return typeof command.target === 'string' ? command.target : command.target.id;
  }
  return undefined;
}

describe('window commands', () => {
  it.each([
    ['close Atlas', 'a'],
    ['Close Atlas.', 'a'],
    ['hide bravo', 'b'],
    ['dismiss the codex window', 'b'],
    ["close Atlas's terminal", 'a'],
    ['can you close Atlas', 'a'],
    ['please close Bravo', 'b'],
    ['get rid of Bravo', 'b'],
    ['close at less', 'a'],
    ['close brave oh', 'b'],
  ])('%s closes one agent', (utterance, id) => {
    const command = parse(utterance);
    expect(command?.kind).toBe('close');
    expect(agentOf(command)).toBe(id);
  });

  it.each(['close', 'Close.', 'close this', 'close that window', 'hide it', 'close this one'])(
    '%s closes whatever is in front of the user',
    (utterance) => {
      expect(parse(utterance, 'a')).toEqual({ kind: 'close', agent: null });
    }
  );

  it('never treats a close as a stop, interrupt, or reject', () => {
    for (const utterance of ['close', 'close Atlas', 'close all']) {
      expect(parse(utterance)?.kind).not.toMatch(/^(?:reject|interrupt|kill|archive)$/);
    }
  });

  it.each([
    ['close all', 'all'],
    ['close everything', 'all'],
    ['hide all the windows', 'all'],
    ['close the others', 'others'],
    ['close everything else', 'others'],
    ['close the finished ones', 'done'],
  ])('%s closes many (%s)', (utterance, scope) => {
    expect(parse(utterance, 'a')).toEqual({ kind: 'closeMany', scope });
  });

  it('leaves an unknown close target to the model instead of guessing', () => {
    expect(parse('close the pull request')).toBeNull();
  });

  it.each([
    ['reopen', 'last'],
    ['undo that', 'last'],
    ['bring it back', 'last'],
    ['reopen all', 'all'],
    ['show hidden windows', 'all'],
    ['reopen Cedar', 'c'],
    ['bring Cedar back', 'c'],
    ['unhide Cedar', 'c'],
  ])('%s reopens %s', (utterance, target) => {
    const command = parse(utterance);
    expect(command?.kind).toBe('reopen');
    expect(agentOf(command)).toBe(target);
  });

  it('finds closed agents by name for focus too', () => {
    const command = parse('go to Cedar');
    expect(command?.kind).toBe('focus');
    expect(agentOf(command)).toBe('c');
  });

  it.each([
    ['kill Atlas', 'kill', 'a'],
    ['shut down Bravo', 'kill', 'b'],
    ['shut Bravo down', 'kill', 'b'],
    ["terminate Atlas's session", 'kill', 'a'],
    ['archive Bravo', 'archive', 'b'],
    ['allow Atlas', 'permission', 'a'],
    ["approve Bravo's request", 'permission', 'b'],
    ['deny Atlas', 'permission', 'a'],
  ])('%s -> %s', (utterance, kind, id) => {
    const command = parse(utterance);
    expect(command?.kind).toBe(kind);
    expect(agentOf(command)).toBe(id);
  });

  it('distinguishes allow from deny', () => {
    expect(parse('allow Atlas')).toMatchObject({ decision: 'allow' });
    expect(parse('deny Atlas')).toMatchObject({ decision: 'deny' });
  });

  it('keeps bare yes/no/stop as confirm and reject', () => {
    expect(parse('allow')?.kind).toBe('confirm');
    expect(parse('deny')?.kind).toBe('reject');
    expect(parse('stop')?.kind).toBe('reject');
    expect(parse('hold on')?.kind).toBe('reject');
    expect(parse('scratch that')?.kind).toBe('reject');
    expect(parse('stop Atlas')?.kind).toBe('interrupt');
  });

  it('asks which agent when a deictic target has nothing focused', () => {
    expect(parse('kill this one')?.kind).toBe('clarify');
    expect(parse('kill this one', 'b')).toMatchObject({ kind: 'kill' });
  });

  it('explains close versus archive for delete', () => {
    const command = parse('delete Atlas');
    expect(command?.kind).toBe('clarify');
    expect(command && 'question' in command && command.question).toMatch(/close Atlas.*archive/);
  });

  it.each(['help', 'what can I say', 'commands', 'what can you do'])('%s -> help', (utterance) => {
    expect(parse(utterance)).toEqual({ kind: 'help' });
  });

  it('still routes messages that merely mention closing to the agent', () => {
    const command = parse('tell Atlas to close the modal');
    expect(command).toMatchObject({ kind: 'send', text: 'close the modal' });
    expect(agentOf(command)).toBe('a');
  });
});
