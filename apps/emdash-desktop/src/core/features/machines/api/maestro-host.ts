import { z } from 'zod';

/**
 * Adding and maintaining a "Maestro host": the Maestro app on another computer, reached over its
 * own WebSocket listener instead of SSH. The requests to the host run in the main process.
 */

export const maestroHostErrorSchema = z.object({
  type: z.enum([
    /** The address could not be understood. */
    'invalid-url',
    /** Nothing answered at the address. */
    'unreachable',
    /** Something answered, but it is not a Maestro host. */
    'not-maestro-host',
    /** Cloudflare Access (or another gateway in front of the host) turned the request away. */
    'cloudflare-access',
    /** The host rejected the pairing code. */
    'invalid-code',
    /** The host is throttling pairing attempts. */
    'rate-limited',
    /** The address now answers as a different host than the one this machine was paired with. */
    'host-mismatch',
    /** That host is already a machine on this device. */
    'already-added',
    /** The machine to change no longer exists or is not a Maestro host. */
    'not-found',
    /** Anything else, including a host that answered with an unexpected reply. */
    'failed',
  ]),
  message: z.string(),
});

export type MaestroHostError = z.infer<typeof maestroHostErrorSchema>;
export type MaestroHostErrorType = MaestroHostError['type'];

/** What a host says about itself before any pairing. */
export const maestroHostInfoSchema = z.object({
  /** The normalised address the host was reached at. */
  url: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  protocolVersion: z.string(),
});

export type MaestroHostInfo = z.infer<typeof maestroHostInfoSchema>;

/**
 * Cloudflare Access service token. A blank secret alongside the machine's saved client ID means
 * "keep the saved secret"; secrets are never sent back to the renderer.
 */
const cfAccessInput = {
  cfAccessClientId: z.string().optional(),
  cfAccessClientSecret: z.string().optional(),
};

export const inspectMaestroHostInputSchema = z.object({
  url: z.string(),
  ...cfAccessInput,
  /** The machine being edited, so its saved Cloudflare secret can be reused. */
  machineId: z.string().optional(),
});

export const addMaestroHostInputSchema = z.object({
  url: z.string(),
  code: z.string(),
  ...cfAccessInput,
});

export const repairMaestroHostInputSchema = z.object({
  id: z.string().min(1),
  code: z.string(),
});

export const updateMaestroHostInputSchema = z.object({
  id: z.string().min(1),
  url: z.string(),
  ...cfAccessInput,
});

export type InspectMaestroHostInput = z.infer<typeof inspectMaestroHostInputSchema>;
export type AddMaestroHostInput = z.infer<typeof addMaestroHostInputSchema>;
export type RepairMaestroHostInput = z.infer<typeof repairMaestroHostInputSchema>;
export type UpdateMaestroHostInput = z.infer<typeof updateMaestroHostInputSchema>;
