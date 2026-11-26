import { z } from 'zod';

const nonBlankStringSchema = z.string().trim().min(1);

/**
 * A terminal agent's reasoning effort id, appended to its CLI as a flag value (for example
 * Claude's `--effort high`). Restricted to a plain token so the value can never read as another
 * flag. Absent or null means the CLI's own default.
 */
export const tuiEffortIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

/**
 * Common error surface for starting a headless session. Runtime-specific
 * errors may carry additional fields; automations only need the tag and
 * optional message.
 */
export const sessionStartErrorSchema = z.object({
  type: nonBlankStringSchema,
  message: z.string().optional(),
});

export const headlessPromptInputSchema = z.object({
  text: nonBlankStringSchema,
  hiddenContext: z.string().optional(),
});

export const acpSessionLaunchInputSchema = z.object({
  conversationId: nonBlankStringSchema,
  providerId: nonBlankStringSchema,
  cwd: nonBlankStringSchema,
  sessionId: z.null(),
  model: nonBlankStringSchema.nullable(),
  modeId: nonBlankStringSchema.nullable().optional(),
  /** Provider-native ACP effort id (`thought_level` option). An id the session does not offer is
   * cleared and reported, never a launch failure. Absent or null means the provider default. */
  effort: nonBlankStringSchema.nullable().optional(),
  initialQueue: z.array(headlessPromptInputSchema).min(1),
});

export const acpSessionLaunchResultSchema = z.object({
  sessionId: nonBlankStringSchema,
});

export const tuiSessionStartInputSchema = z.object({
  conversationId: nonBlankStringSchema,
  providerId: nonBlankStringSchema,
  cwd: nonBlankStringSchema,
  sessionId: z.null(),
  model: nonBlankStringSchema.nullable(),
  initialPrompt: nonBlankStringSchema,
  autoApprove: z.boolean(),
  effort: tuiEffortIdSchema.nullable().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const tuiSessionStartResultSchema = z.object({
  outcome: z.enum(['started', 'attached']),
});

export type SessionStartError = z.infer<typeof sessionStartErrorSchema>;
export type AcpSessionLaunchInput = z.infer<typeof acpSessionLaunchInputSchema>;
export type AcpSessionLaunchResult = z.infer<typeof acpSessionLaunchResultSchema>;
export type TuiSessionStartInput = z.infer<typeof tuiSessionStartInputSchema>;
export type TuiSessionStartResult = z.infer<typeof tuiSessionStartResultSchema>;
