import { z } from 'zod';

/** The host's own updater, as an owner client sees it. */
export const hostUpdateStateSchema = z.object({
  status: z.enum(['unsupported', 'idle', 'checking', 'available', 'downloading', 'downloaded']),
  version: z.string().optional(),
});
export type HostUpdateState = z.infer<typeof hostUpdateStateSchema>;

export const hostUpdateRequestSchema = z.object({
  /** `idle` installs once no agent or automation run is active; `now` does not wait. */
  when: z.enum(['idle', 'now']),
});
export type HostUpdateRequest = z.infer<typeof hostUpdateRequestSchema>;

export const hostUpdateErrorSchema = z.object({
  type: z.enum(['unsupported', 'no-update', 'failed']),
  message: z.string(),
});
export type HostUpdateError = z.infer<typeof hostUpdateErrorSchema>;
