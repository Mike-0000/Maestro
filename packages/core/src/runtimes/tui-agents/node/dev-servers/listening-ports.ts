import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { recordSpawn } from '@emdash/shared/perf';
import type { PreviewServerProtocol } from '#services/preview-detection/node';
import { parseProcessTable, type PidPpidPair } from '#services/pty/api';

/** A TCP socket in the LISTEN state and the process that owns it. */
export type ListeningSocket = {
  pid: number;
  /** Bound address without brackets: `0.0.0.0`, `::`, `127.0.0.1`, `::1`, `*`, or a LAN address. */
  address: string;
  port: number;
};

/** A process-table row; `createdAt` (ms, any epoch) lets stale parent links be told apart. */
export type ProcessTableRow = PidPpidPair & { createdAt?: number };

/** Host data the process-tree port detector reads: listening sockets and the process table. */
export type ProcessPortSnapshotter = {
  listListeners(): Promise<ListeningSocket[]>;
  listProcesses(): Promise<ProcessTableRow[]>;
};

/** Answers which protocol a loopback port speaks HTTP on, or null when it does not answer HTTP. */
export type HttpPortProbe = (host: string, port: number) => Promise<PreviewServerProtocol | null>;

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const HTTP_PROBE_TIMEOUT_MS = 1_500;

/**
 * Parses `netstat -ano` (Windows). Keeps TCP rows whose foreign address has port 0, which is how
 * netstat prints a listening socket; the state column itself is localized, so it is not read.
 * IPv6 rows also say `TCP` and carry bracketed addresses.
 */
export function parseNetstatListeners(output: string): ListeningSocket[] {
  const listeners: ListeningSocket[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 5 || parts[0]?.toUpperCase() !== 'TCP') continue;
    const local = splitHostPort(parts[1]!);
    const foreign = splitHostPort(parts[2]!);
    const pid = Number(parts[4]);
    if (!local || !foreign || foreign.port !== 0) continue;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    listeners.push({ pid, address: local.host, port: local.port });
  }
  return listeners;
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN -F pn` (macOS, Linux). Field output is one field per line:
 * `p<pid>` starts a process, `n<address>:<port>` names one of its sockets; other fields (`f`, and
 * so on) are skipped. Field output is used because the command column of the table format may
 * contain spaces.
 */
export function parseLsofListeners(output: string): ListeningSocket[] {
  const listeners: ListeningSocket[] = [];
  let pid: number | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (!line.startsWith('n') || pid === null) continue;
    // A connected socket reads `local->remote`; only the local side is wanted.
    const local = splitHostPort(line.slice(1).split('->')[0]!);
    if (!local || local.port === 0) continue;
    listeners.push({ pid, address: local.host, port: local.port });
  }
  return listeners;
}

/**
 * Parses the Windows process table printed by {@link WINDOWS_PROCESS_TABLE_SCRIPT}: one
 * `<pid> <ppid> <createdAtMs>` row per process.
 */
export function parseWindowsProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const createdAt = Number(parts[2]);
    rows.push({ pid, ppid, ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}) });
  }
  return rows;
}

/**
 * Drops parent links that cannot be real. Windows keeps a process's parent id after the parent
 * exits, and the id can then be reused by an unrelated, younger process; a parent created after
 * its child is such a reuse. Without this an orphaned listener could be attributed to whatever
 * process later took its dead parent's id.
 */
export function pruneStaleParentLinks(rows: ProcessTableRow[]): ProcessTableRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.map((row) => {
    const parent = byPid.get(row.ppid);
    if (
      parent &&
      parent.createdAt !== undefined &&
      row.createdAt !== undefined &&
      parent.createdAt > row.createdAt
    ) {
      return { ...row, ppid: -1 };
    }
    return row;
  });
}

/** Whether a listener bound to `address` answers on loopback, and the loopback host to dial. */
export function loopbackProbeHost(address: string): '127.0.0.1' | '::1' | null {
  const host = address.toLowerCase();
  if (host === '*' || host === '0.0.0.0' || host.startsWith('127.')) return '127.0.0.1';
  if (host === '::ffff:127.0.0.1' || host === '::ffff:0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '::1') return '::1';
  return null;
}

function splitHostPort(value: string): { host: string; port: number } | null {
  const index = value.lastIndexOf(':');
  if (index <= 0) return null;
  const host = value.slice(0, index).replace(/^\[|\]$/g, '');
  const portText = value.slice(index + 1);
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65_535) return null;
  return { host, port };
}

/**
 * Prints `<pid> <ppid> <createdAtMs>` per process. The creation time is milliseconds since 1601,
 * small enough to stay exact in a JavaScript number.
 */
const WINDOWS_PROCESS_TABLE_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
  "ForEach-Object { $c = 0; if ($_.CreationDate) { $c = [long]($_.CreationDate.ToFileTimeUtc() / 10000) }; '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $c }";

function runCommand(file: string, args: string[]): Promise<string> {
  recordSpawn('other', path.basename(file));
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: COMMAND_MAX_BUFFER,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        // lsof exits 1 when nothing matches; output, when there is any, is still good.
        if (error && !stdout) reject(error);
        else resolve(stdout);
      }
    );
  });
}

function windowsSystemExecutable(...segments: string[]): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', ...segments);
}

/**
 * Reads listening sockets and the process table from this computer. Asynchronous throughout so
 * it never blocks the process it runs in; Windows tools are called by absolute path.
 */
export function createLocalProcessPortSnapshotter(
  platform: NodeJS.Platform = process.platform
): ProcessPortSnapshotter {
  if (platform === 'win32') {
    return {
      listListeners: async () =>
        parseNetstatListeners(await runCommand(windowsSystemExecutable('netstat.exe'), ['-ano'])),
      listProcesses: async () =>
        pruneStaleParentLinks(
          parseWindowsProcessTable(
            await runCommand(
              windowsSystemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe'),
              ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT]
            )
          )
        ),
    };
  }
  return {
    listListeners: async () =>
      parseLsofListeners(await runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])),
    // POSIX reparents orphans to init, so a parent id never points at an unrelated process.
    listProcesses: async () =>
      parseProcessTable(await runCommand('ps', ['-A', '-o', 'pid=,ppid='])),
  };
}

/**
 * Whether `host:port` answers HTTP: plain first, then TLS (dev certificates are usually
 * self-signed, so the certificate is not checked; nothing is sent but a request for `/`). A TCP
 * connect alone would also accept a database or a debugger port.
 */
export async function probeHttpPort(
  host: string,
  port: number
): Promise<PreviewServerProtocol | null> {
  if (await answersHttp(host, port, false)) return 'http:';
  if (await answersHttp(host, port, true)) return 'https:';
  return null;
}

function answersHttp(host: string, port: number, secure: boolean): Promise<boolean> {
  recordSpawn('probe');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const options = {
      host,
      port,
      method: 'GET',
      path: '/',
      agent: false as const,
      timeout: HTTP_PROBE_TIMEOUT_MS,
      headers: { Connection: 'close' },
    };
    const request = secure
      ? https.request({ ...options, rejectUnauthorized: false })
      : http.request(options);
    request.on('response', (response) => {
      finish(true);
      response.destroy();
      request.destroy();
    });
    request.on('timeout', () => {
      finish(false);
      request.destroy();
    });
    request.on('error', () => finish(false));
    request.end();
  });
}
