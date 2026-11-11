import { STATE_GLYPH_LABELS, StateGlyph } from '@emdash/ui/react/components';
import type { StateGlyphState } from '@emdash/ui/react/components';
import type { AgentStatus } from '@core/primitives/agents/api';

/**
 * A conversation's indicator status in the one state language (design brief 2.6): working pulses,
 * waiting on the developer is the filled dot, a finish not looked at yet is the bright ring, an
 * error is the error dot. Anything else (idle, or seen) draws nothing.
 */
export function conversationGlyphState(status: AgentStatus | null): StateGlyphState | null {
  switch (status) {
    case 'working':
      return 'working';
    case 'awaiting-input':
      return 'needs-you';
    case 'completed':
      return 'unread';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

/**
 * The state mark for a conversation row or tab. Announced in words (the mark itself carries no
 * tooltip, so it can fade under a row's hover actions).
 */
export function ConversationStateGlyph({
  status,
  className,
}: {
  status: AgentStatus | null;
  className?: string;
}) {
  const state = conversationGlyphState(status);
  if (!state) return null;
  return (
    <span role="img" aria-label={STATE_GLYPH_LABELS[state]} className={className}>
      <StateGlyph state={state} />
    </span>
  );
}
