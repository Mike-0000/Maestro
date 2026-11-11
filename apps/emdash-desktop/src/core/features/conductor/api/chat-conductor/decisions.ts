import { z } from 'zod';
import type { CompletionReport } from '@core/primitives/agents/api/completion-report';
import type {
  ConductorDecision,
  ConductorDecisionEvent,
  ConductorDecisionOutcome,
  ConductorDecisionRequest,
} from '@core/primitives/agents/api/conductor-decisions';
import {
  DECISION_DETAIL_CHARS,
  DECISION_HEADLINE_CHARS,
} from '@core/primitives/agents/api/conductor-decisions';

/**
 * Wire schemas for the conductor's decisions on needs-you and done (types and timing in
 * `@core/primitives/agents/api/conductor-decisions`). The renderer's chat conductors:
 *
 * 1. `claimDecisions` with every conversation whose conductor can decide, on each change and every
 *    `DECISION_CLAIM_RENEW_MS`; an empty list gives every conversation back.
 * 2. On `decisions` `requested`: `ackDecision` at once (within `ackBy`), run the event turn, then
 *    `resolveDecision` (within `decideBy`). A turn that cannot run or fails resolves `fallback`.
 * 3. On `closed`: the hold is gone (applied, superseded, or fallen back); a turn still running
 *    for it no longer decides anything.
 * 4. `openDecisions` after (re)attaching, for requests that went out before.
 */

const notificationTypeSchema = z.enum([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
]);

const completionReportSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  appUrls: z.array(z.string()).readonly(),
  source: z.literal('terminal-tail').optional(),
}) satisfies z.ZodType<CompletionReport>;

export const conductorDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('surface'),
    state: z.enum(['needs_you', 'done']),
    headline: z.string().min(1).max(DECISION_HEADLINE_CHARS),
    detail: z.string().max(DECISION_DETAIL_CHARS).optional(),
    notify: z.boolean(),
  }),
  z.object({ kind: z.literal('quiet'), answered: z.boolean().optional() }),
  z.object({ kind: z.literal('fallback'), reason: z.string().max(200) }),
]) satisfies z.ZodType<ConductorDecision>;

export const conductorDecisionRequestSchema = z.object({
  holdId: z.string(),
  conversationId: z.string(),
  kind: z.enum(['finished', 'awaiting-input']),
  notificationType: notificationTypeSchema.optional(),
  completionReport: completionReportSchema.nullable(),
  completionSummary: z.string().nullable(),
  requestedAt: z.number(),
  ackBy: z.number(),
  decideBy: z.number(),
}) satisfies z.ZodType<ConductorDecisionRequest>;

export const conductorDecisionEventSchema = z.discriminatedUnion('type', [
  conductorDecisionRequestSchema.extend({ type: z.literal('requested') }),
  z.object({
    type: z.literal('closed'),
    holdId: z.string(),
    conversationId: z.string(),
    reason: z.enum(['resolved', 'superseded', 'timed-out', 'fallback']),
  }),
]) satisfies z.ZodType<ConductorDecisionEvent>;

export const conductorDecisionOutcomeSchema = z.enum([
  'decision',
  'late',
  'stale',
]) satisfies z.ZodType<ConductorDecisionOutcome>;
