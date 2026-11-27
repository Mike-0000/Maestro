import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import {
  CLIENT_CONNECTION_FILE,
  clientLaunchSwitch,
  clientUserDataDirName,
  isValidClientProfile,
  storedClientConnectionSchema,
} from '@core/primitives/client-mode/api/client-profile';
import type { ClientProfile, ClientProfilesError } from '../api/contract';

// Lists and starts the client profiles on this computer. Pure apart from the injected file system
// and spawn, so it tests without Electron. Spawning is security-sensitive: no shell, an argv array
// only, and every profile name is validated here, never trusted from the renderer.

export type ClientProfilesFs = {
  readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  readFile(path: string): Promise<string>;
  /** Creates one directory; rejects (EEXIST) when it already exists. */
  mkdir(path: string): Promise<void>;
};

export type SpawnedProcess = {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
};

export type SpawnOptions = {
  detached: true;
  stdio: 'ignore';
  env: NodeJS.ProcessEnv;
  windowsHide: false;
};

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => SpawnedProcess;

export type ClientProfilesDeps = {
  /** `app.getPath('appData')`, where every profile directory lives. */
  appDataDir: string;
  /** The local app's user-data directory name (`USER_DATA_DIR_NAME`). */
  baseName: string;
  execPath: string;
  /** Set for an unpackaged run, where the executable is Electron and needs the app path. */
  appPath: string | null;
  env: NodeJS.ProcessEnv;
  fs: ClientProfilesFs;
  spawn: SpawnProcess;
};

export type ClientProfilesOperations = {
  list(): Promise<ClientProfile[]>;
  add(name: string): Promise<Result<ClientProfile, ClientProfilesError>>;
  open(profile: string | null): Promise<Result<void, ClientProfilesError>>;
};

/**
 * Variables that must not reach a launched client: Electron-as-Node would start a bare Node
 * process, and the others would point the client at the local app's data or override its switch.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'MAESTRO_CLIENT',
  'EMDASH_USER_DATA_DIR',
  'EMDASH_DB_FILE',
] as const;

/** The name the default profile is shown under; reserved so no named profile can look like it. */
const RESERVED_NAMES = new Set(['default']);

/**
 * The profile a user-data directory belongs to: null for the default profile, a slug for a named
 * one, undefined when the directory is not a client profile of this app.
 */
export function profileFromDirName(baseName: string, dirName: string): string | null | undefined {
  const defaultName = clientUserDataDirName(baseName, null);
  if (dirName === defaultName) return null;
  const prefix = `${defaultName}-`;
  if (!dirName.startsWith(prefix)) return undefined;
  const profile = dirName.slice(prefix.length);
  return isValidClientProfile(profile) ? profile : undefined;
}

/**
 * The paired host from a profile's `client-connection.json` text: its address and name only. The
 * encrypted credentials are never decrypted or returned.
 */
export function readSavedHost(text: string): { serverUrl: string; hostName: string | null } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = storedClientConnectionSchema.safeParse(json);
  if (!parsed.success) return null;
  return { serverUrl: parsed.data.url, hostName: parsed.data.hostName || null };
}

/** The command line and environment that start `profile` as its own detached app. */
export function buildClientLaunch(options: {
  execPath: string;
  appPath: string | null;
  profile: string | null;
  env: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const launchSwitch = clientLaunchSwitch(options.profile);
  const env: NodeJS.ProcessEnv = { ...options.env };
  for (const name of STRIPPED_ENV) delete env[name];
  return {
    command: options.execPath,
    args: options.appPath ? [options.appPath, launchSwitch] : [launchSwitch],
    env,
  };
}

/** Normalizes and checks a new profile name; the result is the slug to use. */
export function parseNewProfileName(name: string): Result<string, ClientProfilesError> {
  const slug = name.trim().toLowerCase();
  if (slug.length === 0) return err({ type: 'invalid', message: 'Enter a name.' });
  if (RESERVED_NAMES.has(slug)) {
    return err({ type: 'invalid', message: `"${slug}" is reserved. Choose another name.` });
  }
  if (!isValidClientProfile(slug)) {
    return err({
      type: 'invalid',
      message:
        'Use up to 32 letters, digits and dashes, starting with a letter or digit (for example "work-vm").',
    });
  }
  return ok(slug);
}

export async function listClientProfiles(deps: ClientProfilesDeps): Promise<ClientProfile[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.fs.readdir(deps.appDataDir);
  } catch {
    return [];
  }
  const profiles: Array<string | null> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = profileFromDirName(deps.baseName, entry.name);
    if (profile !== undefined) profiles.push(profile);
  }
  profiles.sort(compareProfiles);
  return Promise.all(profiles.map((profile) => describeProfile(deps, profile)));
}

export function createClientProfilesOperations(
  deps: () => ClientProfilesDeps
): ClientProfilesOperations {
  return {
    list: () => listClientProfiles(deps()),

    async add(name) {
      const parsed = parseNewProfileName(name);
      if (!parsed.success) return parsed;
      const profile = parsed.data;
      const current = deps();
      try {
        await current.fs.mkdir(profileDir(current, profile));
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          return err({ type: 'exists', message: `A client named "${profile}" already exists.` });
        }
        return err({ type: 'failed', message: `Could not create it: ${errorMessage(error)}` });
      }
      const launched = await launchClientProfile(current, profile);
      if (!launched.success) return launched;
      return ok({ profile, serverUrl: null, hostName: null });
    },

    async open(profile) {
      if (profile !== null && !isValidClientProfile(profile)) {
        return err({ type: 'invalid', message: 'That is not a valid client name.' });
      }
      const current = deps();
      const known = await listClientProfiles(current);
      if (!known.some((entry) => entry.profile === profile)) {
        return err({
          type: 'not-found',
          message: 'That client no longer exists on this computer.',
        });
      }
      return launchClientProfile(current, profile);
    },
  };
}

/** Starts `profile` detached; a profile that already runs focuses its window and this one exits. */
export function launchClientProfile(
  deps: ClientProfilesDeps,
  profile: string | null
): Promise<Result<void, ClientProfilesError>> {
  const launch = buildClientLaunch({
    execPath: deps.execPath,
    appPath: deps.appPath,
    profile,
    env: deps.env,
  });
  return new Promise((resolve) => {
    let child: SpawnedProcess;
    try {
      child = deps.spawn(launch.command, launch.args, {
        detached: true,
        stdio: 'ignore',
        env: launch.env,
        windowsHide: false,
      });
    } catch (error) {
      resolve(err({ type: 'failed', message: `Could not start it: ${errorMessage(error)}` }));
      return;
    }
    // A failed spawn reports through 'error'; without a listener it would crash the main process.
    child.once('error', (error) =>
      resolve(err({ type: 'failed', message: `Could not start it: ${error.message}` }))
    );
    child.once('spawn', () => {
      child.unref();
      resolve(ok());
    });
  });
}

async function describeProfile(
  deps: ClientProfilesDeps,
  profile: string | null
): Promise<ClientProfile> {
  let host: ReturnType<typeof readSavedHost> = null;
  try {
    host = readSavedHost(
      await deps.fs.readFile(join(profileDir(deps, profile), CLIENT_CONNECTION_FILE))
    );
  } catch {
    host = null;
  }
  return { profile, serverUrl: host?.serverUrl ?? null, hostName: host?.hostName ?? null };
}

function profileDir(deps: ClientProfilesDeps, profile: string | null): string {
  return join(deps.appDataDir, clientUserDataDirName(deps.baseName, profile));
}

function compareProfiles(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.localeCompare(b);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
