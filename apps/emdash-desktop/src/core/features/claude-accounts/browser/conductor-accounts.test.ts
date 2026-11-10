import { describe, expect, it } from 'vitest';
import type { ClaudeAccountsState, ClaudeAccountUsage } from '../api/types';
import {
  claudeAccountContextLines,
  claudeAccountListLines,
  matchClaudeAccount,
} from './conductor-accounts';

const NOW = Date.parse('2026-11-10T12:00:00Z');

const state: ClaudeAccountsState = {
  defaultAccountId: 'primary',
  accounts: [
    { id: 'primary', label: 'Primary', kind: 'primary', loggedIn: true, plan: 'max' },
    { id: 'a1', label: 'Work', kind: 'extra', loggedIn: true, configDir: '/x/a1' },
    { id: 'a2', label: 'Side Project', kind: 'extra', loggedIn: false, configDir: '/x/a2' },
  ],
};

function usage(entries: ClaudeAccountUsage[]): Map<string, ClaudeAccountUsage> {
  return new Map(entries.map((entry) => [entry.accountId, entry]));
}

const snapshot = {
  fetchedAt: '2026-11-10T11:40:00Z',
  subscriptionType: 'pro',
  fiveHour: { usedPercent: 12.2, resetsAt: '2026-11-10T14:30:00Z' },
  sevenDay: { usedPercent: 91, resetsAt: '2026-11-13T12:00:00Z' },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  limits: [],
};

describe('claudeAccountContextLines', () => {
  it('says nothing with a single account', () => {
    const single = { ...state, accounts: state.accounts.slice(0, 1) };
    expect(claudeAccountContextLines(single, usage([]), NOW)).toEqual([]);
    expect(claudeAccountContextLines(null, usage([]), NOW)).toEqual([]);
  });

  it('lists each account with both windows, the default and sign-in state', () => {
    const lines = claudeAccountContextLines(
      state,
      usage([
        { accountId: 'primary', status: 'fresh', snapshot: { ...snapshot, fiveHour: null } },
        { accountId: 'a1', status: 'stale', snapshot, reason: 'token-expired' },
        { accountId: 'a2', status: 'unavailable', snapshot: null, reason: 'not-logged-in' },
      ]),
      NOW
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('claude_account');
    expect(lines[1]).toBe(
      '- Primary (default, Pro plan): 5-hour 0% used (no window open); weekly 91% used, resets in 3 days'
    );
    expect(lines[2]).toMatch(
      /^- Work \(Pro plan\): 5-hour 12% used, resets in 2 hr; weekly 91% used, resets in 3 days; figures are old/
    );
    expect(lines[3]).toBe('- Side Project: not signed in, cannot be used');
  });

  it('says so when usage has not loaded', () => {
    const lines = claudeAccountContextLines(state, usage([]), NOW);
    expect(lines[1]).toBe('- Primary (default, Max plan): usage unknown');
  });
});

describe('matchClaudeAccount', () => {
  it('matches a label loosely and the default by word', () => {
    expect(matchClaudeAccount(state, 'work')?.id).toBe('a1');
    expect(matchClaudeAccount(state, 'the Work account')?.id).toBe('a1');
    expect(matchClaudeAccount(state, 'side-project')?.id).toBe('a2');
    expect(matchClaudeAccount(state, 'side')?.id).toBe('a2');
    expect(matchClaudeAccount(state, 'default')?.id).toBe('primary');
    expect(matchClaudeAccount(state, 'Primary')?.id).toBe('primary');
  });

  it('matches nothing when no account or several fit', () => {
    expect(matchClaudeAccount(state, 'personal')).toBeNull();
    expect(matchClaudeAccount(state, 'the account')).toBeNull();
    const twins: ClaudeAccountsState = {
      ...state,
      accounts: [
        ...state.accounts,
        { id: 'a3', label: 'Work 2', kind: 'extra', loggedIn: true, configDir: '/x/a3' },
      ],
    };
    expect(matchClaudeAccount(twins, 'work')?.id).toBe('a1');
    expect(matchClaudeAccount(twins, 'wor')).toBeNull();
  });
});

describe('claudeAccountListLines', () => {
  it("lists every account with its usage and marks the chat's own and the default", () => {
    const lines = claudeAccountListLines(
      state,
      usage([
        { accountId: 'primary', status: 'fresh', snapshot },
        { accountId: 'a1', status: 'fresh', snapshot: { ...snapshot, fiveHour: null } },
        { accountId: 'a2', status: 'unavailable', snapshot: null, reason: 'not-logged-in' },
      ]),
      NOW,
      'a1'
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('- Primary (default for new agents, Pro plan): 5-hour 12% used');
    expect(lines[2]).toContain("- Work (this chat's agent runs on it");
    expect(lines[2]).toContain('weekly 91% used');
    expect(lines[3]).toBe('- Side Project: not signed in, cannot be used');
  });

  it('lists a single account too, and says when the agent runs on none', () => {
    const single = { ...state, accounts: state.accounts.slice(0, 1) };
    const lines = claudeAccountListLines(single, usage([]), NOW, null);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('- Primary (default for new agents');
    expect(lines[2]).toContain('not Claude Code');
    expect(claudeAccountListLines(null, usage([]), NOW, null)).toEqual([
      'Claude accounts are not available.',
    ]);
  });
});
