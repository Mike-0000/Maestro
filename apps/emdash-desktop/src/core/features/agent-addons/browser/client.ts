import type { ContractClient } from '@emdash/wire/rpc';
import { agentAddonsContract, agentAddonsDomain } from '@core/features/agent-addons/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type AgentAddonsRpcClient = ContractClient<typeof agentAddonsContract>;

export function getAgentAddonsClient(): Promise<AgentAddonsRpcClient> {
  return domainClient<AgentAddonsRpcClient>(agentAddonsDomain, agentAddonsContract);
}
