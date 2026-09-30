import { describe, expect, it } from 'vitest';
import { suggestAgents, type SuggestableProvider } from './agent-suggestions';

const PROVIDERS: SuggestableProvider[] = [
  { id: 'claude', name: 'Claude Code', label: 'Claude' },
  { id: 'cline', name: 'Cline', label: 'Cline' },
  { id: 'codex', name: 'Codex', label: 'Codex' },
  { id: 'oh-my-pi', name: 'Oh My Pi', label: 'Oh My Pi' },
  { id: 'opencode', name: 'OpenCode', label: 'OpenCode' },
  { id: 'pi', name: 'Pi', label: 'Pi' },
];

const ids = (typed: string) => suggestAgents(typed, PROVIDERS).map((s) => s.providerId);

describe('suggestAgents', () => {
  it('offers to open the agent on the canvas', () => {
    expect(suggestAgents('Claude', PROVIDERS)).toEqual([
      { providerId: 'claude', label: 'Open Claude agent on the canvas' },
    ]);
  });

  it('matches partial names case-insensitively', () => {
    expect(ids('CL')).toEqual(['claude', 'cline']);
    expect(ids('cla')).toEqual(['claude']);
  });

  it('matches Oh My Pi by its full name, without spaces, and as OMP', () => {
    expect(ids('Oh My Pi')).toEqual(['oh-my-pi']);
    expect(ids('ohmypi')).toEqual(['oh-my-pi']);
    expect(ids('OMP')).toEqual(['oh-my-pi']);
    expect(ids('om')).toEqual(['oh-my-pi']);
  });

  it('puts an exact name ahead of later-word matches', () => {
    expect(ids('pi')).toEqual(['pi', 'oh-my-pi']);
  });

  it('accepts "open …" and "… agent" around the name', () => {
    expect(ids('open claude')).toEqual(['claude']);
    expect(ids('codex agent')).toEqual(['codex']);
  });

  it('offers nothing for empty text or ordinary commands', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
    expect(ids('close Bravo')).toEqual([]);
    expect(ids('tell Atlas to run the tests')).toEqual([]);
  });
});
