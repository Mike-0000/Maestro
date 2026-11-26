import type { Controller } from '@emdash/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import {
  guardClientUpdates,
  isLocalAppRunning,
  LOCAL_APP_RUNNING_MESSAGE,
  LOCAL_APP_UNKNOWN_MESSAGE,
  type ProcessInfo,
} from './updates';

const EXE = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Maestro\\Maestro.exe';

function probe(processes: ProcessInfo[]) {
  return {
    listProcesses: async () => processes,
    execPath: EXE,
    pid: 100,
    platform: 'win32' as const,
  };
}

describe('isLocalAppRunning', () => {
  it('ignores this process, helpers, other clients and other executables', async () => {
    await expect(
      isLocalAppRunning(
        probe([
          { pid: 100, executablePath: EXE, commandLine: `"${EXE}" --maestro-client` },
          { pid: 101, executablePath: EXE, commandLine: `"${EXE}" --type=renderer` },
          { pid: 102, executablePath: EXE, commandLine: `"${EXE}" --maestro-client=work` },
          { pid: 103, executablePath: 'D:\\dev\\electron.exe', commandLine: 'electron.exe .' },
        ])
      )
    ).resolves.toBe(false);
  });

  it('finds a local main process of the same executable', async () => {
    await expect(
      isLocalAppRunning(
        probe([{ pid: 200, executablePath: EXE.toLowerCase(), commandLine: `"${EXE}"` }])
      )
    ).resolves.toBe(true);
  });
});

describe('guardClientUpdates', () => {
  const inner: Controller = {
    call: vi.fn(async (path: string) => ({ success: true, path })),
    resolveLive: () => null,
    acquireLive: () => null,
  };

  it('passes reads through and refuses installs while the local app runs', async () => {
    const guarded = guardClientUpdates(inner, async () => true);
    await expect(guarded.call('getState', undefined)).resolves.toEqual({
      success: true,
      path: 'getState',
    });
    await expect(guarded.call('download', undefined)).resolves.toEqual({
      success: false,
      error: LOCAL_APP_RUNNING_MESSAGE,
    });
    await expect(guarded.call('quitAndInstall', undefined)).resolves.toEqual({
      success: false,
      error: LOCAL_APP_RUNNING_MESSAGE,
    });
  });

  it('refuses when the check itself fails, and allows when nothing else runs', async () => {
    const failing = guardClientUpdates(inner, async () => {
      throw new Error('no powershell');
    });
    await expect(failing.call('download', undefined)).resolves.toEqual({
      success: false,
      error: LOCAL_APP_UNKNOWN_MESSAGE,
    });
    const clear = guardClientUpdates(inner, async () => false);
    await expect(clear.call('download', undefined)).resolves.toEqual({
      success: true,
      path: 'download',
    });
  });
});
