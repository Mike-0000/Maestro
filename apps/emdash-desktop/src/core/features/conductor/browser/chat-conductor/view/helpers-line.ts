import type { RunningSubAgents } from '../sub-agent-strip';

/**
 * The footer's helpers fact: how many sub-agents run, and what the first one the host named is
 * doing ("3 helpers · Reading flow4_v2.png", "1 helper"). Null when none run.
 */
export function helpersLine(running: RunningSubAgents): string | null {
  const count = typeof running === 'number' ? running : running.length;
  if (!Number.isFinite(count) || count < 1) return null;
  const whole = Math.floor(count);
  const counted = whole === 1 ? '1 helper' : `${whole} helpers`;
  if (typeof running === 'number') return counted;
  const label = running.find((agent) => !agent.counted && agent.label.trim().length > 0)?.label;
  return label ? `${counted} · ${label.trim()}` : counted;
}
