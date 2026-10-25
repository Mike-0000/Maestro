import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { subAgentCount } from '@core/primitives/agents/api';

export type StatusPresentation = { label: string; className: string };

export function statusPresentation(
  entry: Pick<AgentTileEntry, 'status' | 'notificationType' | 'backgroundAgents'>
): StatusPresentation {
  switch (entry.status) {
    case 'working':
      return {
        label: entry.backgroundAgents
          ? `Working · ${subAgentCount(entry.backgroundAgents)}`
          : 'Working',
        className: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
      };
    case 'awaiting-input':
      return {
        label: entry.notificationType === 'permission_prompt' ? 'Needs permission' : 'Needs you',
        className: 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
      };
    case 'error':
      return { label: 'Error', className: 'bg-red-500/15 text-red-700 dark:text-red-300' };
    case 'completed':
      return { label: 'Done', className: 'bg-green-500/15 text-green-700 dark:text-green-300' };
    default:
      return { label: 'Idle', className: 'bg-foreground/5 text-foreground-muted' };
  }
}
