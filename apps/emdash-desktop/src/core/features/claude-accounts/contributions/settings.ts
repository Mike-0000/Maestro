import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';
import { PRIMARY_CLAUDE_ACCOUNT_ID } from '../api/types';

/**
 * What the app remembers about Claude accounts. No credential is ever stored here: sign-ins
 * live in each account's own folder, written by the Claude Code CLI.
 */

/** Ids become folder names, so they are held to a safe alphabet. */
export const CLAUDE_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const identitySchema = z.object({
  email: z.string().optional(),
  plan: z.string().optional(),
  loggedIn: z.boolean().optional(),
});

const storedAccountSchema = identitySchema.extend({
  id: z
    .string()
    .regex(CLAUDE_ACCOUNT_ID_PATTERN)
    .refine((id) => id !== PRIMARY_CLAUDE_ACCOUNT_ID),
  label: z.string().min(1),
  createdAt: z.string(),
});

export type StoredClaudeIdentity = z.infer<typeof identitySchema>;
export type StoredClaudeAccount = z.infer<typeof storedAccountSchema>;

export type ClaudeAccountsSettings = {
  /** Extra accounts only; the primary account is built in. */
  accounts: StoredClaudeAccount[];
  defaultAccountId: string;
  /** Last identity seen for the primary account. A display cache, not the account itself. */
  primaryIdentity: StoredClaudeIdentity;
  /** Move a conversation that stops on a usage limit to another signed-in account. */
  autoSwitchOnLimit: boolean;
};

export const DEFAULT_CLAUDE_ACCOUNTS_SETTINGS: ClaudeAccountsSettings = {
  accounts: [],
  defaultAccountId: PRIMARY_CLAUDE_ACCOUNT_ID,
  primaryIdentity: {},
  autoSwitchOnLimit: true,
};

export const claudeAccountsSettingsContribution = defineSettingsContribution<
  'claudeAccounts',
  ClaudeAccountsSettings
>({
  key: 'claudeAccounts',
  schema: z.object({
    accounts: z.array(storedAccountSchema),
    defaultAccountId: z.string().min(1),
    primaryIdentity: identitySchema,
    // On unless the user turned it off: stored values from before the setting existed get it.
    autoSwitchOnLimit: z.boolean().default(true),
  }),
  defaults: DEFAULT_CLAUDE_ACCOUNTS_SETTINGS,
});
