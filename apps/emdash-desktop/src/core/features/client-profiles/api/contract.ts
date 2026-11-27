import { defineContract, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

// The client profiles on this computer: each `--maestro-client[=<name>]` instance of this same app
// keeps its own user-data directory beside the local app's. The local app lists them and starts
// them so nobody has to type the switch. Everything on disk and every launch happens in the main
// process, which validates names itself.

/** Longest profile name; the pattern itself is enforced again by the main process. */
const PROFILE_NAME_MAX = 32;

export const clientProfileSchema = z.object({
  /** The profile slug, or null for the default profile (`--maestro-client`). */
  profile: z.string().nullable(),
  /** The paired host's address, or null before the profile has paired. Never the token. */
  serverUrl: z.string().nullable(),
  /** The paired host's name as it reported it, when known. */
  hostName: z.string().nullable(),
});
export type ClientProfile = z.infer<typeof clientProfileSchema>;

export const clientProfilesErrorSchema = z.object({
  type: z.enum(['invalid', 'exists', 'not-found', 'unsupported', 'failed']),
  message: z.string(),
});
export type ClientProfilesError = z.infer<typeof clientProfilesErrorSchema>;

const profileRefSchema = z.object({ profile: z.string().max(PROFILE_NAME_MAX).nullable() });

export const clientProfilesDomain = 'clientProfiles' as const;

export const clientProfilesContract = defineContract({
  /** Every client profile on this computer, the default one first. */
  list: procedure({ input: z.void(), output: z.array(clientProfileSchema) }),
  /** Creates a new named profile and starts it; it asks for its host when it opens. */
  add: fallible({
    input: z.object({ name: z.string().max(PROFILE_NAME_MAX) }),
    data: clientProfileSchema,
    error: clientProfilesErrorSchema,
  }),
  /** Starts an existing profile, or focuses its window when it already runs. */
  open: fallible({ input: profileRefSchema, data: z.void(), error: clientProfilesErrorSchema }),
});

export type ClientProfilesContract = typeof clientProfilesContract;
