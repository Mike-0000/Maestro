import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { RemoteAccessError, RemoteAccessTailscale } from '@core/features/remote-access/api';

const COMMAND_TIMEOUT_MS = 8_000;
const HTTPS_PORT = '443';

type CommandResult = { ok: true; stdout: string } | { ok: false; message: string };

export type TailscaleRunner = (args: readonly string[]) => Promise<CommandResult>;

/** The CLI is on PATH on most systems; the Windows installer does not always add it. */
function tailscaleExecutable(): string {
  if (process.platform === 'win32') {
    const installed = join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Tailscale',
      'tailscale.exe'
    );
    if (existsSync(installed)) return installed;
  }
  return 'tailscale';
}

const runTailscale: TailscaleRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      tailscaleExecutable(),
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // Tailscale explains a refusal on stdout and then waits, so a timeout still has text.
          resolve({ ok: false, message: (stderr || stdout || error.message).trim() });
          return;
        }
        resolve({ ok: true, stdout });
      }
    );
  });

const UNAVAILABLE: RemoteAccessTailscale = {
  available: false,
  running: false,
  dnsName: null,
  serving: false,
  url: null,
  detail: null,
};

/** Reads whether Tailscale is up and already forwards its HTTPS name to the listener. */
export async function inspectTailscale(
  port: number,
  run: TailscaleRunner = runTailscale
): Promise<RemoteAccessTailscale> {
  const status = await run(['status', '--json']);
  if (!status.ok) return { ...UNAVAILABLE, detail: status.message || null };
  const parsed = parseJson(status.stdout);
  const self = record(parsed?.Self);
  const dnsName =
    typeof self?.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/u, '') : null;
  const running = parsed?.BackendState === 'Running';
  if (!running || !dnsName) {
    return {
      available: true,
      running,
      dnsName,
      serving: false,
      url: null,
      detail: running ? null : 'Tailscale is not signed in on this computer.',
    };
  }

  const serve = await run(['serve', 'status', '--json']);
  const serving = serve.ok && servesListener(parseJson(serve.stdout), dnsName, port);
  return {
    available: true,
    running: true,
    dnsName,
    serving,
    url: serving ? `https://${dnsName}` : null,
    detail: null,
  };
}

export async function setTailscaleServe(
  port: number,
  enabled: boolean,
  run: TailscaleRunner = runTailscale
): Promise<Result<RemoteAccessTailscale, RemoteAccessError>> {
  const result = await run(
    enabled
      ? ['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`]
      : ['serve', `--https=${HTTPS_PORT}`, 'off']
  );
  if (!result.ok) {
    return err({
      type: 'failed',
      message: describeServeFailure(result.message),
    });
  }
  return ok(await inspectTailscale(port, run));
}

/**
 * Serving needs a one-time approval in the tailnet's admin console. Tailscale prints the link
 * and waits; the link is what the person needs.
 */
export function describeServeFailure(output: string): string {
  if (/serve is not enabled/iu.test(output)) {
    const link = /https:\/\/login\.tailscale\.com\/\S+/u.exec(output)?.[0];
    return link
      ? `Tailscale Serve is not enabled for your tailnet yet. Open ${link} to enable it, then try again.`
      : 'Tailscale Serve is not enabled for your tailnet yet. Enable HTTPS and Serve in the Tailscale admin console, then try again.';
  }
  return output || 'Tailscale did not accept the change.';
}

/** True when the node's HTTPS name proxies its root path to the listener's loopback port. */
export function servesListener(
  status: Record<string, unknown> | undefined,
  dnsName: string,
  port: number
): boolean {
  const web = record(status?.Web);
  const handlers = record(record(web?.[`${dnsName}:${HTTPS_PORT}`])?.Handlers);
  const proxy = record(handlers?.['/'])?.Proxy;
  if (typeof proxy !== 'string') return false;
  try {
    const target = new URL(proxy);
    const loopback = target.hostname === '127.0.0.1' || target.hostname === 'localhost';
    return loopback && Number(target.port) === port;
  } catch {
    return false;
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
