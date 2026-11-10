import {
  MAX_CLAUDE_ACCOUNT_LABEL_LENGTH,
  PRIMARY_CLAUDE_ACCOUNT_ID,
  type ClaudeAccount,
  type ClaudeAccountsError,
  type ClaudeAccountsState,
  type ClaudeAccountUsage,
} from '../api/types';

/** The provider Claude accounts belong to. */
export const CLAUDE_PROVIDER_ID = 'claude';

/** The sign-in method the Claude Code CLI offers for a subscription. */
export const CLAUDE_LOGIN_METHOD_ID = 'claude-login';

/** Readable copy for every way an account change can fail. */
export function claudeAccountsErrorMessage(error: ClaudeAccountsError): string {
  switch (error.type) {
    case 'not-found':
      return 'That account no longer exists.';
    case 'primary-immutable':
      return "The primary account can't be renamed or removed.";
    case 'invalid-label':
      return `Give the account a name of up to ${MAX_CLAUDE_ACCOUNT_LABEL_LENGTH} characters.`;
    case 'cli-unavailable':
      return "Claude Code didn't answer. Check that it is installed, then try again.";
    case 'folder-failed':
      return "Maestro couldn't update this account's folder. Close any agents using it, then try again.";
  }
}

/** Why a label can't be used, or null when it can. Mirrors what the backend accepts. */
export function accountLabelProblem(
  label: string,
  others: readonly Pick<ClaudeAccount, 'label'>[] = []
): string | null {
  const clean = label.trim();
  if (!clean) return 'Give the account a name.';
  if (clean.length > MAX_CLAUDE_ACCOUNT_LABEL_LENGTH) {
    return `Use at most ${MAX_CLAUDE_ACCOUNT_LABEL_LENGTH} characters.`;
  }
  const lower = clean.toLowerCase();
  if (others.some((other) => other.label.trim().toLowerCase() === lower)) {
    return 'Another account already has this name.';
  }
  return null;
}

/** `max` -> `Max`, `max_20x` -> `Max 20x`. Null when the plan is unknown. */
export function formatClaudePlan(plan: string | null | undefined): string | null {
  const words = (plan ?? '')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Whether an account has a sign-in. The stored identity can lag behind (it is only refreshed on
 * request), so a usage answer that got past the sign-in check counts as well.
 */
export function isAccountSignedIn(
  account: Pick<ClaudeAccount, 'loggedIn'>,
  usage?: Pick<ClaudeAccountUsage, 'snapshot' | 'reason'>
): boolean {
  if (usage?.reason === 'not-logged-in') return false;
  if (account.loggedIn) return true;
  return usage !== undefined && (usage.snapshot !== null || usage.reason !== undefined);
}

/** The line under an account's name: who it is signed in as, and on which plan. */
export function accountIdentityLine(
  account: Pick<ClaudeAccount, 'email' | 'plan'>,
  signedIn: boolean
): string {
  if (!signedIn) return 'Not signed in';
  const plan = formatClaudePlan(account.plan);
  const parts = [account.email, plan ? `${plan} plan` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Signed in';
}

/** How an account reads in a compact picker: its name, marked when it is the default. */
export function accountOptionLabel(
  account: Pick<ClaudeAccount, 'id' | 'label'>,
  defaultAccountId: string
): string {
  return account.id === defaultAccountId ? `${account.label} (default)` : account.label;
}

/**
 * The account "switch" moves the default to: the next signed-in account after the current
 * default, wrapping around. Null when there is no other signed-in account.
 */
export function nextDefaultAccountId(
  state: ClaudeAccountsState,
  isSignedIn: (account: ClaudeAccount) => boolean
): string | null {
  const { accounts, defaultAccountId } = state;
  const start = accounts.findIndex((account) => account.id === defaultAccountId);
  for (let step = 1; step < accounts.length; step++) {
    const candidate = accounts[(Math.max(start, 0) + step) % accounts.length];
    if (candidate && candidate.id !== defaultAccountId && isSignedIn(candidate)) {
      return candidate.id;
    }
  }
  return null;
}

export type AccountPickerInput = {
  /** The agent chosen for the new conversation. */
  providerId: string | null | undefined;
  /** True when the conversation runs on another machine, which keeps its own sign-in. */
  remote: boolean;
  state: ClaudeAccountsState | null;
  /** What the user picked in this form, if anything. */
  chosenId: string | null;
};

export type AccountPickerState = {
  /** Show the picker: Claude Code on this computer, with more than one account. */
  visible: boolean;
  /** The account the picker shows. */
  value: string;
  /** What to send as `claudeAccountId`; undefined lets the backend use the default. */
  claudeAccountId: string | undefined;
};

/** Decides whether a new-agent form offers an account choice, and what it sends. */
export function resolveAccountPicker(input: AccountPickerInput): AccountPickerState {
  const accounts = input.state?.accounts ?? [];
  const defaultId = input.state?.defaultAccountId ?? PRIMARY_CLAUDE_ACCOUNT_ID;
  const visible = input.providerId === CLAUDE_PROVIDER_ID && !input.remote && accounts.length > 1;
  const chosen =
    input.chosenId !== null && accounts.some((account) => account.id === input.chosenId)
      ? input.chosenId
      : null;
  const value = chosen ?? defaultId;
  return { visible, value, claudeAccountId: visible ? value : undefined };
}

/**
 * The name of the account an existing conversation runs under, or null when there is nothing
 * worth showing (another agent, or only one account). A conversation without a recorded account
 * predates accounts and stays on the primary one; a removed account falls back to the default.
 */
export function conversationAccountLabel(
  state: ClaudeAccountsState | null,
  conversation: { providerId: string; claudeAccountId?: string }
): string | null {
  if (!state || state.accounts.length < 2) return null;
  if (conversation.providerId !== CLAUDE_PROVIDER_ID) return null;
  const { accounts, defaultAccountId } = state;
  const recorded = conversation.claudeAccountId ?? PRIMARY_CLAUDE_ACCOUNT_ID;
  const account =
    accounts.find((candidate) => candidate.id === recorded) ??
    accounts.find((candidate) => candidate.id === defaultAccountId);
  return account?.label ?? null;
}

/**
 * The extra account a conversation's sign-in prompt should sign in to, or undefined when the
 * normal provider sign-in is right: another agent, another machine, or a conversation on the
 * primary account (none recorded, or `primary`). A recorded account that was removed runs on
 * the default account, so that is the one to sign in to. `getState` is only read once the
 * conversation is known to name an extra account.
 */
export function conversationSignInAccount(
  getState: () => ClaudeAccountsState | null,
  conversation: { providerId: string; claudeAccountId?: string },
  remote: boolean
): { id: string; label: string } | undefined {
  if (conversation.providerId !== CLAUDE_PROVIDER_ID || remote) return undefined;
  const recorded = conversation.claudeAccountId;
  if (!recorded || recorded === PRIMARY_CLAUDE_ACCOUNT_ID) return undefined;
  const state = getState();
  if (!state) return undefined;
  const account =
    state.accounts.find((candidate) => candidate.id === recorded) ??
    state.accounts.find((candidate) => candidate.id === state.defaultAccountId);
  if (!account || account.kind === 'primary') return undefined;
  return { id: account.id, label: account.label };
}
