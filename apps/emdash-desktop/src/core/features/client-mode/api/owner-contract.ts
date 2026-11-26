import { defineContract, eventStream, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import { notificationTargetSchema } from '@core/services/notifications/api/schemas';
import { buildIdentitySchema } from './build-identity';
import {
  hostUpdateErrorSchema,
  hostUpdateRequestSchema,
  hostUpdateStateSchema,
} from './host-update';

/** The computer the owner client drives, as the host describes itself on attach. */
export const ownerHostInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  arch: z.string(),
  homeDir: z.string(),
});
export type OwnerHostInfo = z.infer<typeof ownerHostInfoSchema>;

export const ownerAttachInputSchema = z.object({
  build: buildIdentitySchema,
  clientName: z.string().min(1).max(80),
  clientPlatform: z.string().max(32),
  /** Replace an owner client that is already attached instead of answering `busy`. */
  takeover: z.boolean(),
});
export type OwnerAttachInput = z.infer<typeof ownerAttachInputSchema>;

export const ownerAttachDataSchema = z.object({
  sessionId: z.string(),
  /** Changes every time the host process starts. */
  hostBootId: z.string(),
  /** Bumped whenever the host's own window ran agents' renderer-side work in between. */
  brainEpoch: z.number().int(),
  build: buildIdentitySchema,
  host: ownerHostInfoSchema,
});
export type OwnerAttachData = z.infer<typeof ownerAttachDataSchema>;

export const ownerAttachErrorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('build-mismatch'), host: buildIdentitySchema }),
  z.object({ type: z.literal('owner-disabled') }),
  z.object({ type: z.literal('busy'), clientName: z.string(), since: z.number() }),
]);
export type OwnerAttachError = z.infer<typeof ownerAttachErrorSchema>;

export const ownerSessionEventSchema = z.discriminatedUnion('type', [
  /** Another owner client took over; this connection is about to close. */
  z.object({ type: z.literal('superseded'), by: z.string() }),
  z.object({ type: z.literal('host-quitting'), reason: z.enum(['update', 'quit']) }),
]);
export type OwnerSessionEvent = z.infer<typeof ownerSessionEventSchema>;

/** An OS notification the host would have shown; the client shows it instead. */
export const ownerNotificationSchema = z.object({
  notificationId: z.string(),
  groupKey: z.string(),
  title: z.string(),
  body: z.string(),
  target: notificationTargetSchema,
});
export type OwnerNotification = z.infer<typeof ownerNotificationSchema>;

/** A URL the host wanted to open in a browser (for example an OAuth sign-in page). */
export const ownerExternalOpenRequestSchema = z.object({
  url: z.string(),
  /** Set when the URL points at the host's loopback, so the client mirrors that port first. */
  loopbackPort: z.number().int().min(1).max(65535).optional(),
});
export type OwnerExternalOpenRequest = z.infer<typeof ownerExternalOpenRequestSchema>;

/** The owner connection's own handshake and lifecycle. */
export const ownerSessionContract = defineContract({
  attach: fallible({
    input: ownerAttachInputSchema,
    data: ownerAttachDataSchema,
    error: ownerAttachErrorSchema,
  }),
  ping: procedure({ input: z.void(), output: z.object({ at: z.number() }) }),
  events: eventStream({ key: z.void(), event: ownerSessionEventSchema }),
  hostUpdateState: procedure({ input: z.void(), output: hostUpdateStateSchema }),
  requestHostUpdate: fallible({ input: hostUpdateRequestSchema, error: hostUpdateErrorSchema }),
});

/** Host-side effects the owner client carries out on its own computer. */
export const ownerBridgeContract = defineContract({
  notifications: eventStream({ key: z.void(), event: ownerNotificationSchema }),
  notificationOpened: procedure({
    input: z.object({ notificationId: z.string(), target: notificationTargetSchema }),
    output: z.void(),
  }),
  externalOpenRequests: eventStream({ key: z.void(), event: ownerExternalOpenRequestSchema }),
});

/**
 * What a host serves an owner client at `/owner/wire`. Nothing under `desktop` or `bridge`
 * answers until `session.attach` succeeded on the connection, and `desktop.<domain>.<path>`
 * answers only where `clientModeRouting` marks the path host-served.
 */
export const ownerHostWireContract = defineContract({
  session: ownerSessionContract,
  bridge: ownerBridgeContract,
  desktop: desktopWireContract,
});

export type OwnerHostWireContract = typeof ownerHostWireContract;
