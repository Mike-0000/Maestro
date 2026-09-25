import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { spokenProviderLabel } from '@core/features/canvas/api/provider-names';
import { log } from '@core/primitives/logging/browser/logger';
import type { RosterAgent } from '../api/resolver';
import { agentMetadata } from './spawn';

export type InstalledProvider = { id: string; name: string };

const PROVIDER_CACHE_MS = 60_000;
let providerCache: { at: number; value: Promise<InstalledProvider[]> } | null = null;

/** Agent CLIs installed on this machine, cached for a minute. */
export function installedProviders(): Promise<InstalledProvider[]> {
  if (providerCache && Date.now() - providerCache.at < PROVIDER_CACHE_MS) {
    return providerCache.value;
  }
  const value = (async () => {
    const [metadata, client] = await Promise.all([agentMetadata(), getAgentsClient()]);
    const result = await client.listAgentInstallationStatus({ host: LOCAL_HOST_REF });
    if (!result.success) return [];
    const available = new Set(
      result.data.filter((status) => status.status === 'available').map((status) => status.id)
    );
    return metadata
      .filter((agent) => available.has(agent.id))
      .map((agent) => ({ id: agent.id, name: agent.name }));
  })().catch((error: unknown) => {
    log.warn('conductor: provider detection failed', { error });
    providerCache = null;
    return [];
  });
  providerCache = { at: Date.now(), value };
  return value;
}

export function toRosterAgent(canvas: CanvasStore, entry: AgentTileEntry): RosterAgent {
  return {
    id: entry.conversationId,
    name: canvas.spokenName(entry.conversationId),
    providerLabel: spokenProviderLabel(entry.providerId),
    taskName: entry.taskName,
  };
}

export function buildRoster(canvas: CanvasStore): RosterAgent[] {
  return canvas.visibleAgentEntries.map((entry) => toRosterAgent(canvas, entry));
}

export function focusedConversationId(canvas: CanvasStore): string | null {
  const tileId = canvas.focusedTileId;
  return tileId ? (canvas.entryForTile(tileId)?.conversationId ?? null) : null;
}

export function entryForConversation(
  canvas: CanvasStore,
  conversationId: string
): AgentTileEntry | undefined {
  return canvas.agentEntries.find((entry) => entry.conversationId === conversationId);
}

function describeStatus(entry: AgentTileEntry): string {
  if (entry.status === 'awaiting-input') {
    return entry.notificationType === 'permission_prompt'
      ? 'waiting on a permission prompt'
      : 'waiting for input';
  }
  if (!entry.sessionActive && entry.type === 'pty') return `${entry.status}, not running`;
  return entry.status;
}

/** The per-turn <context> block: roster, focus, projects, providers, and any open plan. */
export function buildContext(
  canvas: CanvasStore,
  providers: readonly InstalledProvider[],
  extra: readonly string[] = []
): string {
  const lines: string[] = [];
  const entries = canvas.visibleAgentEntries;
  if (entries.length === 0) {
    lines.push('Agents: none yet.');
  } else {
    lines.push('Agents:');
    for (const entry of entries) {
      const diff =
        entry.linesAdded || entry.linesDeleted
          ? `, +${entry.linesAdded}/-${entry.linesDeleted} lines`
          : '';
      lines.push(
        `- ${canvas.spokenName(entry.conversationId)} (${spokenProviderLabel(entry.providerId)}): ${describeStatus(entry)}; task "${entry.taskName}" in project ${entry.projectName}${diff}`
      );
    }
  }
  const focused = focusedConversationId(canvas);
  lines.push(`Focused agent: ${focused ? canvas.spokenName(focused) : 'none'}`);
  const projects = canvas.projectOptions.map((project) => project.name).filter(Boolean);
  lines.push(`Projects: ${projects.length > 0 ? projects.join(', ') : 'none open'}`);
  lines.push(
    `Installed agent providers: ${
      providers.length > 0
        ? providers.map((provider) => `${provider.id} (${provider.name})`).join(', ')
        : 'unknown'
    }`
  );
  lines.push(...extra);
  return lines.join('\n');
}

/** Words the speech engine should expect: spoken names, providers, tasks, projects. */
export function vocabulary(canvas: CanvasStore): string[] {
  const words = new Set<string>(['Chorus', 'Claude', 'Codex', 'worktree']);
  for (const entry of canvas.visibleAgentEntries) {
    words.add(canvas.spokenName(entry.conversationId));
    words.add(spokenProviderLabel(entry.providerId));
    words.add(entry.taskName);
  }
  for (const project of canvas.projectOptions) if (project.name) words.add(project.name);
  return [...words].filter((word) => word.length <= 60);
}
