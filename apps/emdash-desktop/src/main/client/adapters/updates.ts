import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { Controller } from '@emdash/wire/rpc';
import { CLIENT_MODE_SWITCH } from '@core/primitives/client-mode/api/client-profile';

// Rule U. The client and the local app are the same installation, so installing an update from
// the client would also replace (and close) a local Maestro that is running agents. The client
// runs the ordinary updater, but downloading and installing are refused while a local Maestro
// main process from the same executable is running; the user updates from that window instead.

const execFileAsync = promisify(execFile);

export type ProcessInfo = { pid: number; executablePath: string | null; commandLine: string };

export type LocalAppProbe = {
  /** Every process of this executable's name; throws when the OS cannot be asked. */
  listProcesses(): Promise<ProcessInfo[]>;
  execPath: string;
  pid: number;
  platform: NodeJS.Platform;
};

export const LOCAL_APP_RUNNING_MESSAGE =
  'Maestro is also running on this computer outside client mode, and both share one installation. Update from that Maestro window instead.';
export const LOCAL_APP_UNKNOWN_MESSAGE =
  'Could not check whether Maestro is running on this computer outside client mode, so the update was not started. Update from the Maestro window instead.';

/** Whether a local (non-client) Maestro main process from the same executable is running. */
export async function isLocalAppRunning(probe: LocalAppProbe): Promise<boolean> {
  const processes = await probe.listProcesses();
  const sameExecutable = (path: string | null): boolean =>
    path !== null &&
    (probe.platform === 'win32'
      ? path.toLowerCase() === probe.execPath.toLowerCase()
      : path === probe.execPath);
  return processes.some(
    (process) =>
      process.pid !== probe.pid &&
      sameExecutable(process.executablePath) &&
      // Chromium helpers (renderer, GPU, utility) carry `--type=`; only a main process does not.
      !/(^|\s)--type=/.test(process.commandLine) &&
      !hasClientSwitch(process.commandLine)
  );
}

function hasClientSwitch(commandLine: string): boolean {
  return commandLine.split(/\s+/).some((arg) => {
    const unquoted = arg.replace(/^"|"$/g, '');
    return unquoted === CLIENT_MODE_SWITCH || unquoted.startsWith(`${CLIENT_MODE_SWITCH}=`);
  });
}

/**
 * The client's `updates` controller: the local updater's controller with `download` and
 * `quitAndInstall` refused (as the controller's own `{ success: false, error }` answer) while a
 * local Maestro is running or when that cannot be checked.
 */
export function guardClientUpdates(
  inner: Controller,
  localAppRunning: () => Promise<boolean>
): Controller {
  const guarded = new Set(['download', 'quitAndInstall']);
  return {
    async call(path, input, meta) {
      if (guarded.has(path)) {
        let running: boolean;
        try {
          running = await localAppRunning();
        } catch {
          return { success: false, error: LOCAL_APP_UNKNOWN_MESSAGE };
        }
        if (running) return { success: false, error: LOCAL_APP_RUNNING_MESSAGE };
      }
      return await inner.call(path, input, meta);
    },
    resolveLive: (topic) => inner.resolveLive(topic),
    acquireLive: (topic) => inner.acquireLive(topic),
    dispose: async () => {
      await inner.dispose?.();
    },
  };
}

/** Lists processes named like `execPath`, through the OS's own process table. */
export async function listProcessesNamedLike(execPath: string): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const name = basename(execPath).replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    const text = stdout.trim();
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      return typeof record.ProcessId === 'number'
        ? [
            {
              pid: record.ProcessId,
              executablePath:
                typeof record.ExecutablePath === 'string' ? record.ExecutablePath : null,
              commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
            },
          ]
        : [];
    });
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,args='], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const commandLine = match[2]!;
    // `ps` has no separate executable column; a process of this executable starts with its path.
    const executablePath = commandLine.startsWith(execPath) ? execPath : null;
    return [{ pid: Number(match[1]), executablePath, commandLine }];
  });
}
