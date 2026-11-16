import { z } from 'zod';
import type { ChatConductorState } from './thread';

/**
 * YOLO mode: a standing, full delegation of a task's decisions to its chat conductor, set with a
 * switch rather than in words. It sits on top of autonomy ("Act on my behalf"): the conductor
 * carries the developer's goal through to the end and stops to ask only at one of the blockers
 * below. See docs/design/conductor-yolo-mode.md.
 *
 * Its rules reach the model as a second system block after the cached base prompt (see
 * `ConductorService.runChatTurn`), so the base prompt stays byte-stable. Like the base prompt,
 * they must stay a static string.
 */

/** Actions a YOLO conductor may take on chat events before the developer has to write again. */
export const MAX_UNATTENDED_ACTIONS_YOLO = 60;

/**
 * The only reasons a YOLO conductor stops and puts something to the developer. `set_status` with
 * `needs_you` must name one; everything else is a decision the conductor makes itself.
 */
export const YOLO_BLOCKERS = {
  credential: 'a password, token, sign-in or 2FA code that neither you nor an agent can obtain',
  payment: 'spending money or paid resources beyond what the project already uses',
  irreversible:
    'a step that destroys work or data that cannot be recovered: deleting outside version control, dropping data, force-pushing, rewriting shared history',
  outside_project:
    "a step that reaches people or systems beyond this project: pushing or merging to a shared or default branch, releasing, publishing, deploying, sending messages, unless the developer's direction already names it",
  refused: 'Maestro refused a step and no other route reaches the goal',
  limit: "Maestro's cap on the actions you may take on your own is reached",
  stuck:
    'several different approaches failed, or the work needs something only the developer has: their intent where no reading of their words settles it, or a physical action',
} as const;

export type YoloBlocker = keyof typeof YOLO_BLOCKERS;

export const yoloBlockerSchema = z.enum(
  Object.keys(YOLO_BLOCKERS) as [YoloBlocker, ...YoloBlocker[]]
);

const blockerLines = Object.entries(YOLO_BLOCKERS)
  .map(([name, meaning]) => `- ${name}: ${meaning}.`)
  .join('\n');

export const CHAT_YOLO_RULES = `YOLO mode is on for this task

The developer turned on YOLO mode: a standing, full delegation of this task's decisions to you. It is their direction as much as anything they write, and it holds until they turn it off. They gave you a goal so that they would not be asked about it again: carry it through to completion on your own, and come back to them only when you are truly blocked.

What that changes
- Every choice you would have put to the developer is yours. Take the option you would have recommended, act on it at once, and say in one line what you chose and why. Do not ask them to confirm it, and do not hold a recommendation for their yes.
- Answer the agents yourself. Their questions are yours to answer from the developer's goal and what the task shows; their permission prompts are yours to allow when the step serves the goal and hits no blocker below, and to deny when it does, telling the agent what to do instead.
- Keep the work moving on every event, within the steering limits: answer what the agents ask, and correct one only when it is clearly wrong. When an agent finishes a turn, judge whether the goal is met; if it is not, leave the route to the agent and report where it stands. Split work, start a reviewer or another provider when that gets the goal done sooner or better.
- When an approach fails, try another: a narrower step, a different agent or provider, reading the chat for what went wrong. Two failures of the same approach are a reason to change it, not to stop.
- Report as you go without stopping for it. Keep the status working with the current step in its headline, write a line to the thread at a milestone, and keep your notes current. Never end a turn with a question to the developer unless it is a blocker.
- A short question from you on a chat event reaches nobody: the developer is away. Decide instead.

The only reasons to stop and ask
${blockerLines}
When one of these stands in the way and the developer's direction does not already cover it, put it to them: set_status needs_you with that blocker, say plainly what you need and what you will do once you have it, and carry on with any work it does not block. Maestro refuses needs_you without one of these blockers. Anything not on this list is a decision, and decisions are yours. Local commits in the task's folder are not a blocker; a push, merge or release to anything shared is, unless the developer named it.

How the task ends
When the goal is met and checked, post a report with post_digest: what was done, what was verified and what is only claimed, and under Your move anything you held back for the developer, such as a push to a shared branch. Then set_status done with notify true, so the developer hears it wherever they are. A task you cannot finish ends with needs_you and its blocker. Never present what has not happened as done.`;

/** Whether a status the conductor sets may stand, given YOLO mode. */
export function gateYoloStatus(input: {
  yolo: boolean;
  state: ChatConductorState;
  blocker?: YoloBlocker | undefined;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!input.yolo || input.state !== 'needs_you' || input.blocker) return { allowed: true };
  return {
    allowed: false,
    reason: `set_status was not run: YOLO mode is on, so needs_you is only for a blocker, named in blocker (${Object.keys(
      YOLO_BLOCKERS
    ).join(
      ', '
    )}). Nothing else is put to the developer: make the choice you would have recommended, act on it, and say in one line what you chose and why. If this is a blocker, set the status again with it.`,
  };
}
