import { defineContract, eventStream, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type {
  ClaudeAccount,
  ClaudeAccountUsage,
  ClaudeAccountsError,
  ClaudeAccountsEvent,
  ClaudeAccountsState,
} from './types';

export const claudeAccountsDomain = 'claudeAccounts' as const;

const accountInput = z.object({ accountId: z.string().min(1) });
const errorSchema = z.custom<ClaudeAccountsError>();

/**
 * Several Claude Code subscription sign-ins side by side. Signing in is done by the official
 * CLI in a terminal (`agents.startLogin` with `claudeAccountId`); nothing here returns a
 * credential to the renderer.
 */
export const claudeAccountsContract = defineContract({
  list: procedure({ input: z.void(), output: z.custom<ClaudeAccountsState>() }),
  /** Creates the account and its folder. The account is signed out until the user signs in. */
  create: fallible({
    input: z.object({ label: z.string() }),
    data: z.custom<ClaudeAccount>(),
    error: errorSchema,
  }),
  rename: fallible({
    input: accountInput.extend({ label: z.string() }),
    data: z.custom<ClaudeAccount>(),
    error: errorSchema,
  }),
  /** Signs the account out (best effort) and deletes its folder. Refused for the primary account. */
  remove: fallible({ input: accountInput, data: z.void(), error: errorSchema }),
  setDefault: fallible({ input: accountInput, data: z.void(), error: errorSchema }),
  /** Asks the CLI who the account is signed in as and stores email, plan and sign-in state. */
  refreshIdentity: fallible({
    input: accountInput,
    data: z.custom<ClaudeAccount>(),
    error: errorSchema,
  }),
  /**
   * Subscription usage per account, primary first, in the order of `list`; one entry when
   * `accountId` is given (none if that account does not exist). Answers are kept for a minute
   * unless `force` is set.
   */
  usage: procedure({
    input: z.object({ accountId: z.string().min(1).optional(), force: z.boolean().optional() }),
    output: z.custom<ClaudeAccountUsage[]>(),
  }),
  /**
   * Turns the automatic move of conversations that hit a usage limit on or off. Answers with a
   * `changed` event like every other setting change.
   */
  setAutoSwitchOnLimit: procedure({
    input: z.object({ enabled: z.boolean() }),
    output: z.void(),
  }),
  /**
   * `changed` after every change to the accounts, the default or the automatic switch, with the
   * whole new state; `conversation-moved` when a conversation now runs on another account (a
   * manual move through `conversations.moveClaudeAccount`, or the automatic switch);
   * `limit-unhandled` when a conversation stopped on a usage limit and stayed where it was.
   */
  events: eventStream({ key: z.void(), event: z.custom<ClaudeAccountsEvent>() }),
});

export type ClaudeAccountsContract = typeof claudeAccountsContract;
