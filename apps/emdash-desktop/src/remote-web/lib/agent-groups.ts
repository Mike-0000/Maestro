import type { RemoteAgent } from '@emdash/core/services/remote-control/api';

/** The three bands of the agents list, most actionable first. */
export type AgentGroupId = 'attention' | 'working' | 'idle';

export type AgentGroup = {
  id: AgentGroupId;
  label: string;
  agents: RemoteAgent[];
};

export type AgentFilter = {
  /** Null shows every project. */
  projectId: string | null;
  showArchived: boolean;
};

const GROUP_ORDER: readonly AgentGroupId[] = ['attention', 'working', 'idle'];

const GROUP_LABELS: Record<AgentGroupId, string> = {
  attention: 'Needs you',
  working: 'Working',
  idle: 'Idle',
};

export function agentGroupOf(agent: RemoteAgent): AgentGroupId {
  if (agent.needsAttention || agent.status === 'awaiting-input') return 'attention';
  if (agent.status === 'working') return 'working';
  return 'idle';
}

export function filterAgents(agents: readonly RemoteAgent[], filter: AgentFilter): RemoteAgent[] {
  return agents.filter(
    (agent) =>
      (filter.showArchived || !agent.archived) &&
      (filter.projectId === null || agent.projectId === filter.projectId)
  );
}

/** Most recently active first; agents the host has never seen act go last, by name. */
export function compareAgents(a: RemoteAgent, b: RemoteAgent): number {
  const aTime = a.lastActivityAt ?? Number.NEGATIVE_INFINITY;
  const bTime = b.lastActivityAt ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return bTime > aTime ? 1 : -1;
  return a.taskName.localeCompare(b.taskName) || a.conversationId.localeCompare(b.conversationId);
}

/** Splits agents into the list's bands, dropping empty ones. */
export function groupAgents(agents: readonly RemoteAgent[]): AgentGroup[] {
  const buckets: Record<AgentGroupId, RemoteAgent[]> = { attention: [], working: [], idle: [] };
  for (const agent of agents) buckets[agentGroupOf(agent)].push(agent);
  return GROUP_ORDER.filter((id) => buckets[id].length > 0).map((id) => ({
    id,
    label: GROUP_LABELS[id],
    agents: buckets[id].sort(compareAgents),
  }));
}

/** How many live (unarchived) agents are waiting on a person; drives the title and app badge. */
export function countNeedingAttention(agents: readonly RemoteAgent[]): number {
  return agents.filter((agent) => !agent.archived && agentGroupOf(agent) === 'attention').length;
}

/** The text worth previewing in a row: what the agent is asking, else what it last said. */
export function agentPreview(agent: RemoteAgent): string {
  const text = (agentGroupOf(agent) === 'attention' && agent.message) || agent.lastAssistantMessage;
  return (text || agent.message || '').replace(/\s+/g, ' ').trim();
}

/** The project to preselect for a new agent: the one with the most recent agent activity. */
export function mostRecentProjectId(
  agents: readonly RemoteAgent[],
  projectIds: readonly string[]
): string | null {
  const known = new Set(projectIds);
  const latest = agents.filter((agent) => known.has(agent.projectId)).sort(compareAgents)[0];
  return latest?.projectId ?? projectIds[0] ?? null;
}
