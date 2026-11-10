import { describe, expect, it } from 'vitest';
import type { ClaudeAccount, ClaudeAccountsState } from '../api/types';
import {
  accountIdentityLine,
  accountLabelProblem,
  accountOptionLabel,
  claudeAccountsErrorMessage,
  conversationAccountLabel,
  conversationSignInAccount,
  formatClaudePlan,
  isAccountSignedIn,
  nextDefaultAccountId,
  resolveAccountPicker,
} from './account-model';

const primary: ClaudeAccount = { id: 'primary', label: 'Primary', kind: 'primary', loggedIn: true };
const work: ClaudeAccount = { id: 'work', label: 'Work', kind: 'extra', loggedIn: true };
const spare: ClaudeAccount = { id: 'spare', label: 'Spare', kind: 'extra', loggedIn: false };

function state(accounts: ClaudeAccount[], defaultAccountId = 'primary'): ClaudeAccountsState {
  return { accounts, defaultAccountId };
}

describe('claudeAccountsErrorMessage', () => {
  it('has plain copy for every error', () => {
    const messages = [
      claudeAccountsErrorMessage({ type: 'not-found', accountId: 'x' }),
      claudeAccountsErrorMessage({ type: 'primary-immutable' }),
      claudeAccountsErrorMessage({ type: 'invalid-label', message: 'raw' }),
      claudeAccountsErrorMessage({ type: 'cli-unavailable', message: 'ENOENT' }),
      claudeAccountsErrorMessage({ type: 'folder-failed', message: 'EPERM' }),
    ];
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message).toMatch(/\.$/);
      expect(message).not.toMatch(/ENOENT|EPERM|raw/);
    }
  });
});

describe('accountLabelProblem', () => {
  it('accepts a name of 1 to 60 characters', () => {
    expect(accountLabelProblem('Work')).toBeNull();
    expect(accountLabelProblem('x'.repeat(60))).toBeNull();
  });

  it('rejects empty, too long and duplicate names', () => {
    expect(accountLabelProblem('   ')).toBe('Give the account a name.');
    expect(accountLabelProblem('x'.repeat(61))).toBe('Use at most 60 characters.');
    expect(accountLabelProblem(' work ', [work])).toBe('Another account already has this name.');
  });
});

describe('formatClaudePlan', () => {
  it('capitalises words and keeps multipliers', () => {
    expect(formatClaudePlan('max')).toBe('Max');
    expect(formatClaudePlan('max_20x')).toBe('Max 20x');
    expect(formatClaudePlan('team-premium')).toBe('Team Premium');
  });

  it('is null when the plan is unknown', () => {
    expect(formatClaudePlan(undefined)).toBeNull();
    expect(formatClaudePlan(null)).toBeNull();
    expect(formatClaudePlan('  ')).toBeNull();
  });
});

describe('isAccountSignedIn', () => {
  it('trusts the stored identity when there is no usage answer', () => {
    expect(isAccountSignedIn({ loggedIn: true })).toBe(true);
    expect(isAccountSignedIn({ loggedIn: false })).toBe(false);
  });

  it('lets a usage answer that got past the sign-in check count as signed in', () => {
    expect(
      isAccountSignedIn({ loggedIn: false }, { snapshot: null, reason: 'token-expired' })
    ).toBe(true);
  });

  it('lets a missing sign-in on disk overrule a stale identity', () => {
    expect(isAccountSignedIn({ loggedIn: true }, { snapshot: null, reason: 'not-logged-in' })).toBe(
      false
    );
  });
});

describe('accountIdentityLine', () => {
  it('shows email and plan when signed in', () => {
    expect(accountIdentityLine({ email: 'a@b.com', plan: 'max' }, true)).toBe('a@b.com · Max plan');
    expect(accountIdentityLine({ email: 'a@b.com' }, true)).toBe('a@b.com');
    expect(accountIdentityLine({}, true)).toBe('Signed in');
  });

  it('says so when signed out, whatever was known before', () => {
    expect(accountIdentityLine({ email: 'a@b.com', plan: 'max' }, false)).toBe('Not signed in');
  });
});

describe('accountOptionLabel', () => {
  it('marks the default account', () => {
    expect(accountOptionLabel(work, 'work')).toBe('Work (default)');
    expect(accountOptionLabel(work, 'primary')).toBe('Work');
  });
});

describe('nextDefaultAccountId', () => {
  const signedIn = (account: ClaudeAccount) => account.loggedIn;

  it('moves to the next signed-in account and wraps around', () => {
    expect(nextDefaultAccountId(state([primary, work]), signedIn)).toBe('work');
    expect(nextDefaultAccountId(state([primary, work], 'work'), signedIn)).toBe('primary');
  });

  it('skips accounts that are not signed in', () => {
    expect(nextDefaultAccountId(state([primary, spare, work]), signedIn)).toBe('work');
  });

  it('is null when there is nothing to switch to', () => {
    expect(nextDefaultAccountId(state([primary]), signedIn)).toBeNull();
    expect(nextDefaultAccountId(state([primary, spare]), signedIn)).toBeNull();
  });
});

describe('resolveAccountPicker', () => {
  const two = state([primary, work], 'work');

  it('shows for Claude Code on this computer with more than one account', () => {
    expect(
      resolveAccountPicker({ providerId: 'claude', remote: false, state: two, chosenId: null })
    ).toEqual({ visible: true, value: 'work', claudeAccountId: 'work' });
  });

  it('sends the account the user picked', () => {
    expect(
      resolveAccountPicker({ providerId: 'claude', remote: false, state: two, chosenId: 'primary' })
    ).toEqual({ visible: true, value: 'primary', claudeAccountId: 'primary' });
  });

  it('falls back to the default when the picked account is gone', () => {
    expect(
      resolveAccountPicker({ providerId: 'claude', remote: false, state: two, chosenId: 'gone' })
    ).toEqual({ visible: true, value: 'work', claudeAccountId: 'work' });
  });

  it('shows nothing and sends nothing with a single account', () => {
    expect(
      resolveAccountPicker({
        providerId: 'claude',
        remote: false,
        state: state([primary]),
        chosenId: null,
      })
    ).toEqual({ visible: false, value: 'primary', claudeAccountId: undefined });
  });

  it('shows nothing for other agents, other machines, or before accounts load', () => {
    const hidden = { visible: false, claudeAccountId: undefined };
    expect(
      resolveAccountPicker({ providerId: 'codex', remote: false, state: two, chosenId: 'primary' })
    ).toMatchObject(hidden);
    expect(
      resolveAccountPicker({ providerId: 'claude', remote: true, state: two, chosenId: null })
    ).toMatchObject(hidden);
    expect(
      resolveAccountPicker({ providerId: 'claude', remote: false, state: null, chosenId: null })
    ).toMatchObject(hidden);
  });
});

describe('conversationAccountLabel', () => {
  const two = state([primary, work], 'work');

  it('names the recorded account', () => {
    expect(conversationAccountLabel(two, { providerId: 'claude', claudeAccountId: 'work' })).toBe(
      'Work'
    );
  });

  it('treats a conversation without a recorded account as the primary one', () => {
    expect(conversationAccountLabel(two, { providerId: 'claude' })).toBe('Primary');
  });

  it('falls back to the default account when the recorded one was removed', () => {
    expect(conversationAccountLabel(two, { providerId: 'claude', claudeAccountId: 'gone' })).toBe(
      'Work'
    );
  });

  it('is null with one account, for other agents, or before accounts load', () => {
    expect(conversationAccountLabel(state([primary]), { providerId: 'claude' })).toBeNull();
    expect(conversationAccountLabel(two, { providerId: 'codex' })).toBeNull();
    expect(conversationAccountLabel(null, { providerId: 'claude' })).toBeNull();
  });
});

describe('conversationSignInAccount', () => {
  const two = state([primary, work], 'primary');
  const loaded = (value: ClaudeAccountsState | null) => () => value;

  it('names the extra account a Claude conversation runs on', () => {
    expect(
      conversationSignInAccount(
        loaded(two),
        { providerId: 'claude', claudeAccountId: 'work' },
        false
      )
    ).toEqual({ id: 'work', label: 'Work' });
  });

  it('keeps the normal sign-in for the primary account, without reading the accounts', () => {
    const getState = () => {
      throw new Error('accounts must not be read');
    };
    expect(conversationSignInAccount(getState, { providerId: 'claude' }, false)).toBeUndefined();
    expect(
      conversationSignInAccount(
        getState,
        { providerId: 'claude', claudeAccountId: 'primary' },
        false
      )
    ).toBeUndefined();
  });

  it('keeps the normal sign-in for other agents and other machines', () => {
    const getState = () => {
      throw new Error('accounts must not be read');
    };
    expect(
      conversationSignInAccount(getState, { providerId: 'codex', claudeAccountId: 'work' }, false)
    ).toBeUndefined();
    expect(
      conversationSignInAccount(getState, { providerId: 'claude', claudeAccountId: 'work' }, true)
    ).toBeUndefined();
  });

  it('follows a removed account to the default account it now runs on', () => {
    const gone = { providerId: 'claude', claudeAccountId: 'gone' };
    expect(conversationSignInAccount(loaded(state([primary, work], 'work')), gone, false)).toEqual({
      id: 'work',
      label: 'Work',
    });
    // Falling back to the primary account means the normal sign-in.
    expect(conversationSignInAccount(loaded(two), gone, false)).toBeUndefined();
  });

  it('keeps the normal sign-in before accounts have loaded', () => {
    expect(
      conversationSignInAccount(
        loaded(null),
        { providerId: 'claude', claudeAccountId: 'work' },
        false
      )
    ).toBeUndefined();
  });
});
