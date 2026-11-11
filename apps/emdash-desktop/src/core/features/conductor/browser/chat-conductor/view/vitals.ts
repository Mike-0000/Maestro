import type { ChatConductorEntry, ChatConductorState } from '../../../api/chat-conductor/thread';
import { formatDuration } from './thread-view';

/**
 * The footer facts under the conductor's thread: one state line on the left ("Working · 14s ·
 * Reading the chat…", "Needs you · waiting 32s", "Finished · 6m ago", "Idle") and the quiet
 * facts on the right (provider, account, conductor effort).
 */

export type ConductorVitals = {
  glyph: 'working' | 'needs_you' | 'done' | 'idle' | 'error';
  left: string;
  facts: readonly string[];
};

export type ConductorVitalsInput = {
  state: ChatConductorState | null;
  busy: boolean;
  activity: string | null;
  busySinceMs: number | null;
  lastEntryAt: string | null;
  lastEntryKind: ChatConductorEntry['kind'] | null;
  nowMs: number;
  providerLabel: string | null;
  accountLabel: string | null;
  conductorEffort: string | null;
};

function parsed(at: string | null): number | null {
  if (at === null) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function present(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

export function conductorVitals(input: ConductorVitalsInput): ConductorVitals {
  const facts = [
    input.providerLabel,
    input.accountLabel,
    present(input.conductorEffort) ? `conductor on ${input.conductorEffort.trim()} effort` : null,
  ]
    .filter(present)
    .map((fact) => fact.trim());
  const lastAt = parsed(input.lastEntryAt);

  if (input.busy) {
    const parts = ['Working'];
    if (input.busySinceMs !== null) parts.push(formatDuration(input.nowMs - input.busySinceMs));
    if (present(input.activity)) parts.push(input.activity.trim());
    return { glyph: 'working', left: parts.join(' · '), facts };
  }
  if (input.lastEntryKind === 'error') {
    return { glyph: 'error', left: 'Stopped on an error', facts };
  }
  const age = lastAt === null ? null : ageSince(lastAt, input.nowMs);
  switch (input.state) {
    case 'working':
      return {
        glyph: 'working',
        left: age === null ? 'Working' : `Working · last news ${age}`,
        facts,
      };
    case 'needs_you':
      return {
        glyph: 'needs_you',
        left:
          lastAt === null
            ? 'Needs you'
            : `Needs you · waiting ${formatDuration(input.nowMs - lastAt)}`,
        facts,
      };
    case 'done':
      return {
        glyph: 'done',
        left: age === null ? 'Finished' : `Finished · ${age}`,
        facts,
      };
    default:
      return { glyph: 'idle', left: 'Idle', facts };
  }
}

/** "now", "32s ago", "6m ago", "2h ago", "3d ago". A time in the future, or unreadable, is "now". */
export function formatAge(fromIso: string, nowMs: number): string {
  const from = Date.parse(fromIso);
  return Number.isNaN(from) ? 'now' : ageSince(from, nowMs);
}

function ageSince(from: number, nowMs: number): string {
  const seconds = Math.floor((nowMs - from) / 1_000);
  if (!Number.isFinite(seconds) || seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
