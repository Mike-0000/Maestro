import { describe, expect, it } from 'vitest';
import type { MoveClaudeAccountError } from '@core/features/conversations/api/claude-account-move';
import type { ClaudeAccount, ClaudeAccountsState, ClaudeAccountUsage } from '../api/types';
import {
  accountUsageSummary,
  canMoveConversationAccount,
  conversationAccountId,
  moveClaudeAccountErrorCopy,
} from './conversation-move-model';

const primary: ClaudeAccount = {
  id: 'primary',
  label: 'Personal',
  kind: 'primary',
  loggedIn: true,
};
const work: ClaudeAccount = { id: 'work', label: 'Work', kind: 'extra', loggedIn: true };
const two: ClaudeAccountsState = { accounts: [primary, work], defaultAccountId: 'work' };

describe('conversationAccountId', () => {
  it('uses the recorded account, primary when none, and the default for a removed one', () => {
    expect(conversationAccountId(two, { providerId: 'claude', claudeAccountId: 'work' })).toBe(
      'work'
    );
    expect(conversationAccountId(two, { providerId: 'claude' })).toBe('primary');
    expect(conversationAccountId(two, { providerId: 'claude', claudeAccountId: 'gone' })).toBe(
      'work'
    );
  });
});

describe('canMoveConversationAccount', () => {
  it('offers the move only for local Claude conversations with several accounts', () => {
    const claude = { providerId: 'claude' };
    expect(canMoveConversationAccount(two, claude, { remote: false })).toBe(true);
    expect(canMoveConversationAccount(two, claude, { remote: true })).toBe(false);
    expect(canMoveConversationAccount(two, { providerId: 'codex' }, { remote: false })).toBe(false);
    expect(
      canMoveConversationAccount({ accounts: [primary], defaultAccountId: 'primary' }, claude, {
        remote: false,
      })
    ).toBe(false);
    expect(canMoveConversationAccount(null, claude, { remote: false })).toBe(false);
  });
});

describe('accountUsageSummary', () => {
  it('shows the weekly and 5-hour windows that are known', () => {
    const usage: ClaudeAccountUsage = {
      accountId: 'work',
      status: 'fresh',
      snapshot: {
        fetchedAt: new Date(0).toISOString(),
        subscriptionType: 'max',
        fiveHour: { usedPercent: 12.4, resetsAt: null },
        sevenDay: { usedPercent: 45.6, resetsAt: null },
        sevenDayOpus: null,
        sevenDaySonnet: null,
        limits: [],
      },
    };
    expect(accountUsageSummary(usage)).toBe('weekly 46% · 5-hour 12%');
    expect(
      accountUsageSummary({ ...usage, snapshot: { ...usage.snapshot!, sevenDay: null } })
    ).toBe('5-hour 12%');
    expect(accountUsageSummary(undefined)).toBeNull();
  });
});

describe('moveClaudeAccountErrorCopy', () => {
  const accounts = { target: 'Work', previous: 'Personal' };

  it('has readable copy for every error', () => {
    const errors: MoveClaudeAccountError[] = [
      { type: 'conversation-not-found', conversationId: 'c' },
      { type: 'not-claude-conversation' },
      { type: 'not-local', message: 'WSL' },
      { type: 'unsupported', message: 'automation' },
      { type: 'session-unavailable', message: 'task closed' },
      { type: 'account-not-found', accountId: 'work' },
      { type: 'account-signed-out', accountId: 'work' },
      { type: 'same-account', accountId: 'work' },
      { type: 'config-write-failed', message: 'EACCES' },
      { type: 'restart-failed', message: 'no session', restored: false },
    ];
    for (const error of errors) {
      const copy = moveClaudeAccountErrorCopy(error, accounts);
      expect(copy.title).toMatch(/^Couldn't (continue|restart) on Work/);
      expect(copy.description).toBeTruthy();
    }
  });

  it('says where a failed restart went back to', () => {
    expect(
      moveClaudeAccountErrorCopy(
        { type: 'restart-failed', message: 'no session', restored: true },
        accounts
      )
    ).toEqual({ title: "Couldn't restart on Work. The conversation is back on Personal." });
  });
});
