import { defineContract, fallible } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Post-session delivery for automation runs. Observing a session and publishing a
 * branch both reach outside the automations runtime (session runtimes, git, the
 * forge CLI), so the embedding app supplies this contract as a component dependency,
 * the same way it supplies creation admission. Apps that do not deliver pull requests
 * answer every verb with `delivery-unsupported`.
 */

export const automationSessionRefSchema = z.object({
  conversationId: z.string().min(1),
  type: z.enum(['acp', 'tui']),
});

/**
 * - `unknown`: the session runtime has not reported this conversation (yet).
 * - `working`: a turn or background work is in flight.
 * - `settled`: the agent stopped; `clean` is true only for a normal end of turn.
 * - `exited`: the session process is gone.
 */
export const automationSessionStatusSchema = z.object({
  state: z.enum(['unknown', 'working', 'settled', 'exited']),
  clean: z.boolean(),
  detail: z.string().optional(),
});

export const automationPublishInputSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  remote: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  draft: z.boolean(),
});

export const automationPublishResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('pull-request'), url: z.string().min(1) }),
  z.object({ outcome: z.literal('no-changes') }),
]);

export const automationDeliveryErrorSchema = z.object({
  type: z.string().min(1),
  message: z.string().optional(),
});

export const automationDeliveryContract = defineContract({
  sessionStatus: fallible({
    input: automationSessionRefSchema,
    data: automationSessionStatusSchema,
    error: automationDeliveryErrorSchema,
  }),
  /** Stops in-flight agent work; the conversation stays resumable. */
  stopSession: fallible({
    input: automationSessionRefSchema,
    data: z.void(),
    error: automationDeliveryErrorSchema,
  }),
  /**
   * Commits leftover changes, pushes `branch`, and opens a pull request against
   * `baseBranch`. Idempotent: an existing pull request for the branch is returned.
   */
  publish: fallible({
    input: automationPublishInputSchema,
    data: automationPublishResultSchema,
    error: automationDeliveryErrorSchema,
  }),
});

export type AutomationDeliveryContract = typeof automationDeliveryContract;
export type AutomationSessionRef = z.infer<typeof automationSessionRefSchema>;
export type AutomationSessionStatus = z.infer<typeof automationSessionStatusSchema>;
export type AutomationPublishInput = z.infer<typeof automationPublishInputSchema>;
export type AutomationPublishResult = z.infer<typeof automationPublishResultSchema>;
export type AutomationDeliveryError = z.infer<typeof automationDeliveryErrorSchema>;
