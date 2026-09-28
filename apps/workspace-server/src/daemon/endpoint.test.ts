import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorkspaceWireController } from '../testing/controller';
import { serveSocket, type SocketServeHandle } from '../wire/serve-socket';
import {
  createWorkspaceServerPipeAddress,
  defaultDaemonEndpointMode,
  parseEndpointRecord,
  readEndpointRecord,
  removeEndpointRecord,
  resolveDaemonConnectAddress,
  writeEndpointRecord,
} from './endpoint';
import { probeDaemon } from './probe';

const handles: SocketServeHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
});

describe('daemon endpoint records', () => {
  it('uses endpoint records only on Windows', () => {
    expect(defaultDaemonEndpointMode('win32')).toBe('record');
    expect(defaultDaemonEndpointMode('linux')).toBe('socket');
    expect(defaultDaemonEndpointMode('darwin')).toBe('socket');
  });

  it('creates unguessable workspace server pipe addresses', () => {
    const first = createWorkspaceServerPipeAddress();
    const second = createWorkspaceServerPipeAddress();

    expect(first).toMatch(/^\\\\\.\\pipe\\emdash-workspace-server-[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
    expect(parseEndpointRecord(`${first}\r\n`)).toBe(first);
  });

  it('rejects records that do not name a workspace server pipe', () => {
    expect(parseEndpointRecord('')).toBeUndefined();
    expect(parseEndpointRecord('\\\\.\\pipe\\someone-else')).toBeUndefined();
    expect(parseEndpointRecord('\\\\remote-host\\pipe\\emdash-workspace-server-x')).toBeUndefined();
    expect(parseEndpointRecord('/tmp/workspace.sock')).toBeUndefined();
  });

  it('writes, resolves, and removes a record atomically', async () => {
    const recordPath = await tempRecordPath();
    const address = createWorkspaceServerPipeAddress();

    await writeEndpointRecord(recordPath, address);

    expect(await readFile(recordPath, 'utf8')).toBe(`${address}\n`);
    expect(await resolveDaemonConnectAddress(recordPath, 'record')).toEqual({
      kind: 'address',
      address,
    });

    await removeEndpointRecord(recordPath, createWorkspaceServerPipeAddress());
    expect(await readEndpointRecord(recordPath)).toEqual({ kind: 'found', address });

    await removeEndpointRecord(recordPath, address);
    expect(await readEndpointRecord(recordPath)).toEqual({ kind: 'missing' });
  });

  it('refuses to record an unexpected address', async () => {
    await expect(writeEndpointRecord(await tempRecordPath(), 'C:\\evil')).rejects.toThrow(
      'unexpected workspace server address'
    );
  });

  it('reports missing and invalid records as unavailable', async () => {
    const recordPath = await tempRecordPath();
    expect(await resolveDaemonConnectAddress(recordPath, 'record')).toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('not found'),
    });

    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, 'garbage');
    expect(await resolveDaemonConnectAddress(recordPath, 'record')).toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('not a workspace server pipe'),
    });
  });

  it('connects straight to the socket path in socket mode', async () => {
    expect(await resolveDaemonConnectAddress('/home/me/run/workspace.sock', 'socket')).toEqual({
      kind: 'address',
      address: '/home/me/run/workspace.sock',
    });
  });

  it('probes a missing record as not running', async () => {
    const result = await probeDaemon(await tempRecordPath(), {
      endpointMode: 'record',
      timeoutMs: 50,
    });

    expect(result).toMatchObject({ success: false, error: { type: 'not-running' } });
  });

  it.runIf(process.platform === 'win32')(
    'serves over a recorded named pipe and cleans the record up on dispose',
    async () => {
      const recordPath = await tempRecordPath();
      const handle = await serveSocket(
        createTestWorkspaceWireController({}, { appVersion: '4.5.6' }),
        { socketPath: recordPath, endpointMode: 'record' }
      );
      handles.push(handle);

      expect(handle.listenAddress).toMatch(/^\\\\\.\\pipe\\emdash-workspace-server-/);
      expect(parseEndpointRecord(await readFile(recordPath, 'utf8'))).toBe(handle.listenAddress);
      expect(await probeDaemon(recordPath, { endpointMode: 'record' })).toMatchObject({
        success: true,
        data: { version: '4.5.6' },
      });

      await expect(
        serveSocket(createTestWorkspaceWireController({}), {
          socketPath: recordPath,
          endpointMode: 'record',
        })
      ).rejects.toThrow('already listening');

      await handles.splice(0)[0]?.dispose();
      expect(await readEndpointRecord(recordPath)).toEqual({ kind: 'missing' });
    }
  );

  it.runIf(process.platform === 'win32')(
    'replaces a stale record left by a killed daemon',
    async () => {
      const recordPath = await tempRecordPath();
      const staleAddress = createWorkspaceServerPipeAddress();
      await writeEndpointRecord(recordPath, staleAddress);

      const handle = await serveSocket(createTestWorkspaceWireController({}), {
        socketPath: recordPath,
        endpointMode: 'record',
      });
      handles.push(handle);

      expect(handle.listenAddress).not.toBe(staleAddress);
      expect(await readEndpointRecord(recordPath)).toEqual({
        kind: 'found',
        address: handle.listenAddress,
      });
    }
  );
});

async function tempRecordPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'emdash-workspace-daemon-endpoint-'));
  return join(dir, 'run', 'workspace.sock');
}
