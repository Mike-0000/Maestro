import { z } from 'zod';

/**
 * Limits on the chat conductor steering an agent on its own. An agent finds its own way to the
 * goal, and a detour often brings back something useful, so a message the conductor sends on a
 * chat event must name one of four ways the agent is clearly wrong (or answer a question the agent
 * asked), is rate-limited per chat, and is capped before the matter goes back to the developer. Pure, so the renderer and its tests
 * share one definition. A turn the developer started is never limited here: it carries their words.
 */

/**
 * Why the conductor messages an agent on its own: the four ways an agent is clearly wrong, plus
 * `answer`, a reply to a question the agent itself asked.
 */
export const STEER_REASONS = [
  'destructive',
  'leaving_task',
  'looping',
  'against_instruction',
  'answer',
] as const;
export type SteerReason = (typeof STEER_REASONS)[number];
export const steerReasonSchema = z.enum(STEER_REASONS);

/** The tools that put the conductor's words, or its hand, into an agent's work. */
export const STEER_TOOLS: ReadonlySet<string> = new Set(['send_to_agent', 'interrupt_agent']);

/**
 * Least time between two of the conductor's own messages to one chat, unless destructive, or an
 * answer the agent asked for.
 */
export const STEER_COOLDOWN_MS = 10 * 60_000;
/** The conductor's own messages to one chat before the developer has to weigh in again. */
export const MAX_STEERS_PER_CHAT = 2;

/**
 * Whether the conductor may steer a chat's agent now, in a turn a chat event started. `sent` holds
 * the times of its earlier own-initiative messages to that chat since the developer last wrote.
 */
export function gateSteer(input: {
  tool: string;
  reason: SteerReason | undefined;
  sent: readonly number[];
  now: number;
}): { allowed: true } | { allowed: false; reason: string; why: string } {
  const { tool } = input;
  if (!input.reason) {
    return {
      allowed: false,
      why: 'it gave no allowed reason',
      reason: `${tool} was not run: on a chat event you message an agent only to answer a question it asked (answer) or when it is clearly wrong, and you must say how in reason: ${STEER_REASONS.join(', ')}. A different approach, a detour or an investigation is none of these: let the agent explore, note what you saw, and look again at its next turn end. If the developer must decide, put it to them and set the status to needs_you.`,
    };
  }
  if (input.reason === 'answer' && tool !== 'send_to_agent') {
    return {
      allowed: false,
      why: 'answer is a reason only for sending a reply',
      reason: `${tool} was not run: answer is a reason only for send_to_agent, replying to a question the agent asked. Interrupt an agent only for one of: destructive, leaving_task, looping, against_instruction.`,
    };
  }
  if (input.sent.length >= MAX_STEERS_PER_CHAT) {
    return {
      allowed: false,
      why: `it already messaged this agent ${MAX_STEERS_PER_CHAT} times on its own`,
      reason: `${tool} was not run: you have already messaged this chat's agent ${MAX_STEERS_PER_CHAT} times on your own since the developer last wrote, which is the limit. The decision is the developer's now: tell them what you saw (${input.reason}), what you would send and why, and set the status to needs_you. You can message the agent again once they reply.`,
    };
  }
  const last = input.sent.length > 0 ? Math.max(...input.sent) : null;
  const urgent = input.reason === 'destructive' || input.reason === 'answer';
  if (!urgent && last !== null && input.now - last < STEER_COOLDOWN_MS) {
    const minutes = Math.ceil((STEER_COOLDOWN_MS - (input.now - last)) / 60_000);
    return {
      allowed: false,
      why: 'it messaged this agent less than 10 minutes ago',
      reason: `${tool} was not run: you messaged this chat's agent less than 10 minutes ago, and only a destructive reason, or an answer to a question it asked, may follow that sooner (about ${minutes} min left). Let the agent work with what you sent: wait for its next turn end, or put the matter to the developer if it cannot wait.`,
    };
  }
  return { allowed: true };
}
