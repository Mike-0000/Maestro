import type { AgentProviderId } from '@emdash/plugins/agents/types';
import {
  agentWindowName,
  parseAgentWindowNameSlot,
} from '@core/features/conversations/api/agent-window-names';

type ConversationTitleInput = {
  title: string;
};

function capitalizeProviderId(providerId: AgentProviderId): string {
  return `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}`;
}

// Titles created before named windows used "<provider> (<n>)"; keep rendering them as before.
function parseLegacyTitleIndex(title: string, providerId: AgentProviderId): number | null {
  const match = title.match(new RegExp(`^${providerId} \\(([1-9]\\d*)\\)$`, 'i'));
  if (!match) return null;

  const rawIndex = match[1];
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  if (String(index) !== rawIndex) return null;
  return index;
}

export function formatConversationTitleForDisplay(
  providerId: AgentProviderId,
  title: string
): string {
  const index = parseLegacyTitleIndex(title, providerId);
  if (index === null) return title;
  return `${capitalizeProviderId(providerId)} (${index})`;
}

/**
 * Picks the name for a new agent window: the first roster slot not already used by another
 * conversation in the same task, across all providers.
 */
export function nextDefaultConversationTitle(conversations: ConversationTitleInput[]): string {
  const used = new Set<number>();

  for (const conversation of conversations) {
    const slot = parseAgentWindowNameSlot(conversation.title);
    if (slot !== null) used.add(slot);
  }

  let next = 0;
  while (used.has(next)) next += 1;

  return agentWindowName(next);
}
