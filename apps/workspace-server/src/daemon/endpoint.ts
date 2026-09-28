import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * How the daemon's well-known socket path becomes a connectable address.
 *
 * - `socket` (Linux/macOS): the path is the Unix domain socket the daemon listens on, and the
 *   desktop reaches it through OpenSSH streamlocal forwarding.
 * - `record` (Windows): Windows OpenSSH does not forward Unix sockets, and Node listens on named
 *   pipes there. The daemon listens on a pipe with an unguessable name and writes that name into
 *   an endpoint record file at the well-known path, inside the user's private profile directory.
 *   Local clients and the desktop's SSH exec bridge read the record before connecting. The random
 *   name keeps another local account from pre-creating (squatting) a predictable pipe name.
 */
export type DaemonEndpointMode = 'socket' | 'record';

export const WORKSPACE_SERVER_PIPE_NAME_PREFIX = 'emdash-workspace-server-';

const PIPE_ADDRESS_PATTERN =
  /^\\\\\.\\pipe\\emdash-workspace-server-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function defaultDaemonEndpointMode(
  platform: NodeJS.Platform = process.platform
): DaemonEndpointMode {
  return platform === 'win32' ? 'record' : 'socket';
}

export function createWorkspaceServerPipeAddress(): string {
  return `\\\\.\\pipe\\${WORKSPACE_SERVER_PIPE_NAME_PREFIX}${randomUUID()}`;
}

/** Returns the pipe address in an endpoint record, or undefined when it is not one we wrote. */
export function parseEndpointRecord(raw: string): string | undefined {
  const address = raw.trim();
  return PIPE_ADDRESS_PATTERN.test(address) ? address : undefined;
}

export type EndpointRecordReadResult =
  | { kind: 'found'; address: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string };

export async function readEndpointRecord(recordPath: string): Promise<EndpointRecordReadResult> {
  let raw: string;
  try {
    raw = await readFile(recordPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return { kind: 'missing' };
    throw error;
  }
  const address = parseEndpointRecord(raw);
  if (!address) {
    return {
      kind: 'invalid',
      message: `Workspace server endpoint record is not a workspace server pipe: ${recordPath}`,
    };
  }
  return { kind: 'found', address };
}

/** Atomically replaces the endpoint record so readers never observe a partial address. */
export async function writeEndpointRecord(recordPath: string, address: string): Promise<void> {
  if (!parseEndpointRecord(address)) {
    throw new Error(`Refusing to record an unexpected workspace server address: ${address}`);
  }
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  const temporary = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${address}\n`, { mode: 0o600 });
  try {
    await rename(temporary, recordPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Removes the record only while it still names `address`, so a newer daemon's record survives. */
export async function removeEndpointRecord(recordPath: string, address: string): Promise<void> {
  const current = await readEndpointRecord(recordPath).catch(() => undefined);
  if (current?.kind !== 'found' || current.address !== address) return;
  await unlink(recordPath).catch((error: unknown) => {
    if (!isMissingFileError(error)) throw error;
  });
}

export type ConnectAddressResult =
  | { kind: 'address'; address: string }
  | { kind: 'unavailable'; message: string };

/** Resolves the address a client connects to for the daemon at `socketPath`. */
export async function resolveDaemonConnectAddress(
  socketPath: string,
  mode: DaemonEndpointMode = defaultDaemonEndpointMode()
): Promise<ConnectAddressResult> {
  if (mode === 'socket') return { kind: 'address', address: socketPath };
  const record = await readEndpointRecord(socketPath);
  switch (record.kind) {
    case 'found':
      return { kind: 'address', address: record.address };
    case 'missing':
      return {
        kind: 'unavailable',
        message: `Workspace server endpoint record not found: ${socketPath}`,
      };
    case 'invalid':
      return { kind: 'unavailable', message: record.message };
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
