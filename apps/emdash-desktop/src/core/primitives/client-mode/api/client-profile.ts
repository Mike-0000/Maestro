import { z } from 'zod';

// Client-profile naming and the paired-host file, shared by the client main process (which starts
// as a profile and saves its host) and the local app (which lists and launches profiles). Plain
// values only: no Electron and no side effects, so `src/main/client/launch-mode.ts` can use it
// before any bootstrap module loads.

/** The command-line switch that starts the app as a client of a remote Maestro host. */
export const CLIENT_MODE_SWITCH = '--maestro-client';

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** A profile name becomes part of a directory name, so only a short slug is accepted. */
export function isValidClientProfile(value: string): boolean {
  return PROFILE_PATTERN.test(value);
}

/**
 * The user-data directory name of a client profile, beside the local app's own:
 * `<base>-client` or `<base>-client-<profile>`.
 */
export function clientUserDataDirName(baseName: string, profile: string | null): string {
  return profile === null ? `${baseName}-client` : `${baseName}-client-${profile}`;
}

/** The command-line switch that starts this same client profile again. */
export function clientLaunchSwitch(profile: string | null): string {
  return profile === null ? CLIENT_MODE_SWITCH : `${CLIENT_MODE_SWITCH}=${profile}`;
}

/** The one paired host of a client profile, in its user-data directory. */
export const CLIENT_CONNECTION_FILE = 'client-connection.json';

/** The on-disk shape of `client-connection.json`; the secrets are `safeStorage` ciphertext. */
export const storedClientConnectionSchema = z.object({
  version: z.literal(1),
  url: z.string().min(1),
  hostId: z.string().min(1),
  hostName: z.string(),
  deviceId: z.string().min(1),
  /** Base64 of the `safeStorage` ciphertext. */
  token: z.string().min(1),
  cfAccess: z.object({ clientId: z.string(), clientSecret: z.string().min(1) }).optional(),
  pairedAt: z.number(),
});
export type StoredClientConnection = z.infer<typeof storedClientConnectionSchema>;
