import { defineContract, fallible, liveModel, liveState, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const remoteAccessDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** A Maestro app reaches the whole host; a browser only the remote-control surface. */
  kind: z.enum(['desktop', 'browser']),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  /** Number of live connections the device holds right now. */
  connections: z.number().int(),
});
export type RemoteAccessDevice = z.infer<typeof remoteAccessDeviceSchema>;

export const remoteAccessPairingSchema = z.object({
  code: z.string(),
  expiresAt: z.number(),
});
export type RemoteAccessPairing = z.infer<typeof remoteAccessPairingSchema>;

export const remoteAccessTriggerSchema = z.object({
  /** The name a caller sends as `trigger`. */
  name: z.string(),
  automationId: z.string(),
});
export type RemoteAccessTrigger = z.infer<typeof remoteAccessTriggerSchema>;

export const remoteAccessStatusSchema = z.object({
  /** The person's setting; `listening` says whether it took effect. */
  enabled: z.boolean(),
  listening: z.boolean(),
  port: z.number().int(),
  bindAddress: z.string(),
  /** Why the listener is not up although enabled (for example the port is taken). */
  error: z.string().nullable(),
  hostName: z.string(),
  /** False when this build does not include the web app, so browsers cannot be served. */
  webAppAvailable: z.boolean(),
  devices: z.array(remoteAccessDeviceSchema),
  pairing: remoteAccessPairingSchema.nullable(),
  /** The on-demand agent HTTP API: off until a token exists. */
  triggers: z.object({
    tokenSet: z.boolean(),
    routes: z.array(remoteAccessTriggerSchema),
  }),
});
export type RemoteAccessStatus = z.infer<typeof remoteAccessStatusSchema>;

export const remoteAccessTailscaleSchema = z.object({
  /** The Tailscale CLI was found and answered. */
  available: z.boolean(),
  /** This computer is signed in to a tailnet. */
  running: z.boolean(),
  /** This computer's tailnet name, for example `my-pc.tail1234.ts.net`. */
  dnsName: z.string().nullable(),
  /** Tailscale already forwards its HTTPS name to the listener. */
  serving: z.boolean(),
  /** The address to open from another device once `serving` is true. */
  url: z.string().nullable(),
  detail: z.string().nullable(),
});
export type RemoteAccessTailscale = z.infer<typeof remoteAccessTailscaleSchema>;

export const remoteAccessErrorSchema = z.object({
  type: z.enum(['invalid', 'unavailable', 'failed']),
  message: z.string(),
});
export type RemoteAccessError = z.infer<typeof remoteAccessErrorSchema>;

export const remoteAccessDomain = 'remoteAccess' as const;

export const remoteAccessContract = defineContract({
  status: liveModel({
    key: z.void().optional(),
    states: {
      state: liveState({ data: remoteAccessStatusSchema }),
    },
  }),
  configure: fallible({
    input: z.object({
      enabled: z.boolean().optional(),
      port: z.number().int().min(1024).max(65535).optional(),
      bindAddress: z.string().min(1).max(64).optional(),
    }),
    data: z.void(),
    error: remoteAccessErrorSchema,
  }),
  /** Issues a fresh one-time code, replacing any code still outstanding. */
  createPairingCode: procedure({ input: z.void(), output: remoteAccessPairingSchema }),
  cancelPairingCode: procedure({ input: z.void(), output: z.void() }),
  /** Forgets a device and drops its live connections. */
  revokeDevice: procedure({ input: z.object({ deviceId: z.string() }), output: z.void() }),
  /** Replaces the bearer token of the on-demand agent API. The token is shown only here. */
  rotateTriggerToken: fallible({
    input: z.void(),
    data: z.object({ token: z.string() }),
    error: remoteAccessErrorSchema,
  }),
  /** Lets callers start the automation by naming `name`; replaces an existing mapping. */
  setTrigger: fallible({
    input: remoteAccessTriggerSchema,
    data: z.void(),
    error: remoteAccessErrorSchema,
  }),
  removeTrigger: procedure({ input: z.object({ name: z.string() }), output: z.void() }),
  getTailscale: procedure({ input: z.void(), output: remoteAccessTailscaleSchema }),
  /** Turns Tailscale's HTTPS forwarding to the listener on or off. */
  setTailscaleServe: fallible({
    input: z.object({ enabled: z.boolean() }),
    data: remoteAccessTailscaleSchema,
    error: remoteAccessErrorSchema,
  }),
});

export type RemoteAccessContract = typeof remoteAccessContract;
