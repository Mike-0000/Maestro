import type { StateGlyphState } from '@emdash/ui/react/components';
import type { AgentStatus } from '@core/primitives/agents/api';

/**
 * The state of the agent a run started, in the one glyph set and its words (design brief 2.6),
 * the same marks the sidebar and the project task list draw. Idle (or no agent) says nothing.
 */
export function agentRunState(
  status: AgentStatus | null
): { glyph: StateGlyphState; words: string } | null {
  switch (status) {
    case 'awaiting-input':
      return { glyph: 'needs-you', words: 'Needs you' };
    case 'working':
      return { glyph: 'working', words: 'Working' };
    case 'completed':
      return { glyph: 'unread', words: 'Finished' };
    case 'error':
      return { glyph: 'error', words: 'Stopped on an error' };
    default:
      return null;
  }
}
