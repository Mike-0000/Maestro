import {
  remoteVoicePendingSchema,
  remoteVoicePlanSchema,
} from '@emdash/core/services/remote-control/api';
import {
  defineContract,
  eventStream,
  fallible,
  liveModel,
  liveState,
  procedure,
} from '@emdash/wire/rpc';
import { z } from 'zod';

export const remoteAccessDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * A Maestro app reaches the host's workspace runtimes; a browser only the remote-control
   * surface; an owner (a client-mode Maestro) the host's full desktop app.
   */
  kind: z.enum(['desktop', 'browser', 'owner']),
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

/** Full-access (owner) clients: a client-mode Maestro that drives this app as its own. */
export const remoteAccessOwnerAccessSchema = z.object({
  enabled: z.boolean(),
  /** Accept owners only through `tailscale serve` (tailnet identity) or direct loopback. */
  tailscaleOnly: z.boolean(),
  /** Tailnet logins allowed to connect as an owner; empty allows every tailnet user. */
  allowedLogins: z.array(z.string()),
  /** The outstanding owner pairing code, separate from the ordinary one. */
  pairing: remoteAccessPairingSchema.nullable(),
  /** The owner client attached right now; at most one at a time. */
  attachedClient: z
    .object({
      deviceId: z.string(),
      clientName: z.string(),
      clientPlatform: z.string(),
      since: z.number(),
    })
    .nullable(),
});
export type RemoteAccessOwnerAccess = z.infer<typeof remoteAccessOwnerAccessSchema>;

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
  ownerAccess: remoteAccessOwnerAccessSchema,
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

/** The conductor's heads-up display, as this window reports it for paired devices. */
export const remoteConductorSnapshotSchema = z.object({
  phase: z.enum(['idle', 'thinking', 'acting']),
  activity: z.string(),
  lastUtterance: z.string(),
  reply: z.string(),
  replyAt: z.number(),
  error: z.string().nullable(),
  pending: remoteVoicePendingSchema.nullable(),
  plan: remoteVoicePlanSchema.nullable(),
  agentNames: z.array(z.string()),
  /** Vocabulary hints for speech-to-text: agent names, projects, branches. */
  vocabulary: z.array(z.string()).max(200),
});
export type RemoteConductorSnapshot = z.infer<typeof remoteConductorSnapshotSchema>;

/** What a paired device asked the conductor to do; this window carries it out. */
export const remoteConductorCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('utterance'), text: z.string() }),
  z.object({ type: z.literal('respond'), decision: z.enum(['yes', 'no']) }),
]);
export type RemoteConductorCommand = z.infer<typeof remoteConductorCommandSchema>;

export const remoteAccessOwnerSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  tailscaleOnly: z.boolean().optional(),
  allowedLogins: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
});
export type RemoteAccessOwnerSettingsPatch = z.infer<typeof remoteAccessOwnerSettingsPatchSchema>;

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
  /** The window reports the conductor's display so paired devices can mirror it. */
  publishConductorState: procedure({ input: remoteConductorSnapshotSchema, output: z.void() }),
  /** Commands from paired devices for the conductor in this window. */
  conductorCommands: eventStream({ key: z.void(), event: remoteConductorCommandSchema }),
  getTailscale: procedure({ input: z.void(), output: remoteAccessTailscaleSchema }),
  /** Turns Tailscale's HTTPS forwarding to the listener on or off. */
  setTailscaleServe: fallible({
    input: z.object({ enabled: z.boolean() }),
    data: remoteAccessTailscaleSchema,
    error: remoteAccessErrorSchema,
  }),
  /** Changes the owner-access settings; omitted fields keep their value. */
  setOwnerAccess: fallible({
    input: remoteAccessOwnerSettingsPatchSchema,
    data: z.void(),
    error: remoteAccessErrorSchema,
  }),
  /** Issues a one-time owner pairing code; ordinary codes can never create an owner. */
  createOwnerPairingCode: fallible({
    input: z.void(),
    data: remoteAccessPairingSchema,
    error: remoteAccessErrorSchema,
  }),
  cancelOwnerPairingCode: procedure({ input: z.void(), output: z.void() }),
});

export type RemoteAccessContract = typeof remoteAccessContract;
