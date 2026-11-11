import type { ChatConductorState } from '../../../api/chat-conductor/thread';

/** What the composer suggests writing, for where the conductor stands. */
export function composerPlaceholder(input: {
  ready: boolean;
  busy: boolean;
  state: ChatConductorState | null;
}): string {
  if (!input.ready) return 'The conductor is off';
  if (input.busy) return 'Write to the conductor. It is sent when this turn ends.';
  switch (input.state) {
    case 'working':
      return "Ask how it's going, or redirect the work";
    case 'needs_you':
      return 'Answer, or tell the conductor what to do';
    case 'done':
      return "Ask for a change, or say what's next";
    default:
      return 'Tell the conductor what you want from this task';
  }
}
