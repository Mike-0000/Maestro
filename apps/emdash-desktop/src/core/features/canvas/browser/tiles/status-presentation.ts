import type { StateGlyphState } from '@emdash/ui/react/components';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { isYoursAgent } from '@core/features/conductor/api/ownership-line';
import { subAgentCount } from '@core/primitives/agents/api';

/**
 * An agent window's state as the sidebar shows a task's: the kit's state mark and a few words.
 * `yours` follows the ownership line's rule (`isYoursAgent`): a waiting agent stays the
 * developer's after it is seen; a finished or failed one only until it is seen.
 */
export type StatusPresentation = { label: string; glyph: StateGlyphState; yours: boolean };

export function statusPresentation(
  entry: Pick<AgentTileEntry, 'status' | 'notificationType' | 'backgroundAgents'> & {
    seen?: boolean;
  }
): StatusPresentation {
  const yours = isYoursAgent({ status: entry.status, seen: entry.seen ?? false });
  switch (entry.status) {
    case 'working':
      return {
        label: entry.backgroundAgents
          ? `Working · ${subAgentCount(entry.backgroundAgents)}`
          : 'Working',
        glyph: 'working',
        yours,
      };
    case 'awaiting-input':
      return {
        label: entry.notificationType === 'permission_prompt' ? 'Needs permission' : 'Needs you',
        glyph: 'needs-you',
        yours,
      };
    case 'error':
      return { label: 'Error', glyph: 'error', yours };
    case 'completed':
      // A finish not looked at yet is the bright ring, as in the sidebar.
      return { label: 'Done', glyph: yours ? 'unread' : 'done', yours };
    default:
      return { label: 'Idle', glyph: 'idle', yours };
  }
}
