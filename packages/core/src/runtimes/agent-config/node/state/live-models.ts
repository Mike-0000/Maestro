import { type LeasedLiveModelProvider } from '@emdash/wire/rpc';
import { cell, expose, publishStructural, type Cell } from '@emdash/wire/state';
import type { McpServer } from '#primitives/mcp/api';
import type { CatalogSkill } from '#primitives/skills/api';
import {
  agentConfigContract,
  type AgentConfigList,
  type InstalledAddon,
} from '#runtimes/agent-config/api';

export type AgentConfigAgentsLiveHost = LeasedLiveModelProvider<typeof agentConfigContract.agents>;
export type AgentConfigMcpLiveHost = LeasedLiveModelProvider<typeof agentConfigContract.mcpServers>;
export type AgentConfigSkillsLiveHost = LeasedLiveModelProvider<typeof agentConfigContract.skills>;
export type AgentConfigAddonsLiveHost = LeasedLiveModelProvider<typeof agentConfigContract.addons>;
export type AgentConfigAgentsModel = { states: { list: Cell<AgentConfigList> } };
export type AgentConfigMcpModel = { states: { list: Cell<McpServer[]> } };
export type AgentConfigSkillsModel = { states: { list: Cell<CatalogSkill[]> } };
export type AgentConfigAddonsModel = { states: { list: Cell<InstalledAddon[]> } };

export function createAgentConfigAgentsLiveHost(
  model: AgentConfigAgentsModel
): AgentConfigAgentsLiveHost {
  return expose(agentConfigContract.agents, { list: model.states.list });
}

export function createAgentConfigMcpLiveHost(model: AgentConfigMcpModel): AgentConfigMcpLiveHost {
  return expose(agentConfigContract.mcpServers, { list: model.states.list });
}

export function createAgentConfigSkillsLiveHost(
  model: AgentConfigSkillsModel
): AgentConfigSkillsLiveHost {
  return expose(agentConfigContract.skills, { list: model.states.list });
}

export function createAgentConfigAddonsLiveHost(
  model: AgentConfigAddonsModel
): AgentConfigAddonsLiveHost {
  return expose(agentConfigContract.addons, { list: model.states.list });
}

export function createAgentConfigAgentsModel(): AgentConfigAgentsModel {
  return { states: { list: cell({} satisfies AgentConfigList) } };
}

export function createAgentConfigMcpModel(): AgentConfigMcpModel {
  return { states: { list: cell<McpServer[]>([]) } };
}

export function createAgentConfigSkillsModel(): AgentConfigSkillsModel {
  return { states: { list: cell<CatalogSkill[]>([]) } };
}

export function createAgentConfigAddonsModel(): AgentConfigAddonsModel {
  return { states: { list: cell<InstalledAddon[]>([]) } };
}

export function publishLiveModelState<T>(model: Cell<T>, next: T, previous: T | undefined): void {
  if (Object.is(previous, next)) return;
  publishStructural(model, next);
}
