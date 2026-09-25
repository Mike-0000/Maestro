import { describe, expect, it } from 'vitest';
import {
  atPermissionPrompt,
  closeTargets,
  isFinished,
  listNames,
  reopenTargets,
  type WindowAgent,
} from './window-targets';

function agent(id: string, overrides: Partial<WindowAgent> = {}): WindowAgent {
  return {
    conversationId: id,
    type: 'pty',
    status: 'working',
    notificationType: null,
    sessionActive: true,
    ...overrides,
  };
}

const board = [
  agent('a'),
  agent('b', { status: 'completed' }),
  agent('c', { status: 'idle', sessionActive: false }),
  agent('d', { status: 'awaiting-input', sessionActive: false }),
];

describe('closeTargets', () => {
  it('closes everything visible', () => {
    expect(closeTargets(board, 'all', null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the focused agent for "the others"', () => {
    expect(closeTargets(board, 'others', 'a')).toEqual(['b', 'c', 'd']);
    expect(closeTargets(board, 'others', null)).toBeNull();
  });

  it('closes only finished agents, never ones waiting on the user', () => {
    expect(closeTargets(board, 'done', null)).toEqual(['b', 'c']);
    expect(isFinished(agent('x', { status: 'error' }))).toBe(true);
    expect(isFinished(agent('x'))).toBe(false);
  });
});

describe('reopenTargets', () => {
  it('restores the last closed batch while it is still hidden', () => {
    expect(reopenTargets(['x', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to the most recently hidden window', () => {
    expect(reopenTargets(['x', 'a'], ['a', 'b'])).toEqual(['a']);
    expect(reopenTargets(['x'], [])).toEqual(['x']);
    expect(reopenTargets([], ['a'])).toEqual([]);
  });
});

describe('atPermissionPrompt', () => {
  it('flags terminal agents sitting on a permission prompt', () => {
    const waiting = { status: 'awaiting-input', notificationType: 'permission_prompt' } as const;
    expect(atPermissionPrompt(agent('a', waiting))).toBe(true);
    expect(atPermissionPrompt(agent('a', { ...waiting, type: 'acp' }))).toBe(false);
    expect(atPermissionPrompt(agent('a', { status: 'awaiting-input' }))).toBe(false);
  });
});

describe('listNames', () => {
  it('reads naturally', () => {
    expect(listNames(['Atlas'])).toBe('Atlas');
    expect(listNames(['Atlas', 'Bravo'])).toBe('Atlas and Bravo');
    expect(listNames(['Atlas', 'Bravo', 'Cedar'])).toBe('Atlas, Bravo, and Cedar');
    expect(listNames(['Atlas', 'Bravo', 'Cedar', 'Delta'])).toBe('Atlas, Bravo, and 2 more');
  });
});
