import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { claudeAccountsContract, claudeAccountsDomain } from '../contract';

export type ClaudeAccountsRpcClient = ContractClient<typeof claudeAccountsContract>;

export function getClaudeAccountsClient(): Promise<ClaudeAccountsRpcClient> {
  return domainClient<ClaudeAccountsRpcClient>(claudeAccountsDomain, claudeAccountsContract);
}
