import { defineContract, fallible, liveModel, liveState, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { buildIdentitySchema } from './build-identity';
import { hostUpdateErrorSchema, hostUpdateRequestSchema } from './host-update';

/**
 * The client process's own Wire domain. It is served only in client mode, by the client's main
 * process, and is deliberately not part of `desktopDomainContracts`.
 */
export const clientSessionDomain = 'clientSession' as const;

export const clientSessionPhaseSchema = z.enum([
  'unpaired',
  'connecting',
  'connected',
  'reconnecting',
  'blocked',
]);
export type ClientSessionPhase = z.infer<typeof clientSessionPhaseSchema>;

export const clientSessionBlockedReasonSchema = z.enum([
  'build-mismatch',
  'revoked',
  'owner-disabled',
  'busy',
  'superseded',
  'tailscale-required',
]);
export type ClientSessionBlockedReason = z.infer<typeof clientSessionBlockedReasonSchema>;

export const clientSessionStatusSchema = z.object({
  phase: clientSessionPhaseSchema,
  host: z
    .object({
      url: z.string(),
      id: z.string(),
      name: z.string(),
      platform: z.string().optional(),
    })
    .nullable(),
  /** Set only while `phase` is `blocked`: why, and what the screen needs to explain it. */
  blocked: z
    .object({
      reason: clientSessionBlockedReasonSchema,
      detail: z.string().optional(),
      hostBuild: buildIdentitySchema.optional(),
      clientBuild: buildIdentitySchema.optional(),
      busyClientName: z.string().optional(),
    })
    .nullable(),
  /** Reconnect attempts since the link was last attached. */
  attempt: z.number().int(),
  lastError: z.string().nullable(),
  connectedAt: z.number().nullable(),
  latencyMs: z.number().nullable(),
});
export type ClientSessionStatus = z.infer<typeof clientSessionStatusSchema>;

export const clientSessionPairInputSchema = z.object({
  /** The host's address, for example `https://vm.tailnet.ts.net`. */
  url: z.string().min(1).max(2048),
  code: z.string().min(1).max(64),
  cfAccessClientId: z.string().max(256).optional(),
  cfAccessClientSecret: z.string().max(512).optional(),
});
export type ClientSessionPairInput = z.infer<typeof clientSessionPairInputSchema>;

export const clientSessionErrorSchema = z.object({
  type: z.enum(['invalid', 'unreachable', 'rejected', 'unsupported', 'failed']),
  message: z.string(),
});
export type ClientSessionError = z.infer<typeof clientSessionErrorSchema>;

export const clientSessionContract = defineContract({
  status: liveModel({
    key: z.void().optional(),
    states: {
      state: liveState({ data: clientSessionStatusSchema }),
    },
  }),
  /** Exchanges an owner pairing code for a credential, stores it, and connects. */
  pair: fallible({
    input: clientSessionPairInputSchema,
    data: z.void(),
    error: clientSessionErrorSchema,
  }),
  /** Skips the reconnect backoff and dials now. */
  retryNow: procedure({ input: z.void(), output: z.void() }),
  /** Attaches with `takeover: true`, replacing the owner client the host reported as busy. */
  takeOver: procedure({ input: z.void(), output: z.void() }),
  /** Clears the stored host and credentials, then relaunches the client. */
  forget: procedure({ input: z.void(), output: z.void() }),
  relaunch: procedure({ input: z.void(), output: z.void() }),
  requestHostUpdate: fallible({ input: hostUpdateRequestSchema, error: hostUpdateErrorSchema }),
  /** Windows: a Desktop and Start Menu shortcut that starts this client profile. */
  createShortcut: fallible({ input: z.void(), error: clientSessionErrorSchema }),
});

export type ClientSessionContract = typeof clientSessionContract;
