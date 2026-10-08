import { describe, expect, it } from 'vitest';
import {
  inspectTailscale,
  servesListener,
  setTailscaleServe,
  type TailscaleRunner,
} from './tailscale';

const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'studio.tail1234.ts.net.' },
});

function serveStatus(proxy: string): string {
  return JSON.stringify({
    Web: { 'studio.tail1234.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
  });
}

function runner(responses: Record<string, string | Error>): {
  run: TailscaleRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: async (args) => {
      const key = args.join(' ');
      calls.push(key);
      const response = responses[key];
      if (response === undefined || response instanceof Error) {
        return { ok: false, message: response?.message ?? 'unexpected command' };
      }
      return { ok: true, stdout: response };
    },
  };
}

describe('tailscale', () => {
  it('reports unavailable when the CLI is missing', async () => {
    const { run } = runner({ 'status --json': new Error('spawn tailscale ENOENT') });
    expect(await inspectTailscale(7462, run)).toMatchObject({ available: false, serving: false });
  });

  it('reports the HTTPS address once the listener is being served', async () => {
    const { run } = runner({
      'status --json': STATUS,
      'serve status --json': serveStatus('http://127.0.0.1:7462'),
    });
    expect(await inspectTailscale(7462, run)).toEqual({
      available: true,
      running: true,
      dnsName: 'studio.tail1234.ts.net',
      serving: true,
      url: 'https://studio.tail1234.ts.net',
      detail: null,
    });
  });

  it('does not mistake another proxied port for the listener', () => {
    const status = JSON.parse(serveStatus('http://127.0.0.1:3000')) as Record<string, unknown>;
    expect(servesListener(status, 'studio.tail1234.ts.net', 7462)).toBe(false);
    expect(servesListener(undefined, 'studio.tail1234.ts.net', 7462)).toBe(false);
  });

  it('turns serving on with an argument list and reads back the result', async () => {
    const { run, calls } = runner({
      'serve --bg --https=443 http://127.0.0.1:7462': '',
      'status --json': STATUS,
      'serve status --json': serveStatus('http://127.0.0.1:7462'),
    });
    const result = await setTailscaleServe(7462, true, run);
    expect(calls[0]).toBe('serve --bg --https=443 http://127.0.0.1:7462');
    expect(result).toMatchObject({ success: true, data: { serving: true } });
  });

  it('points at the approval link when serving is not enabled for the tailnet', async () => {
    const { run } = runner({
      'serve --bg --https=443 http://127.0.0.1:7462': new Error(
        'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n'
      ),
    });
    const result = await setTailscaleServe(7462, true, run);
    expect(result).toMatchObject({ success: false });
    expect(!result.success && result.error.message).toBe(
      'Tailscale Serve is not enabled for your tailnet yet. Open https://login.tailscale.com/f/serve?node=abc123 to enable it, then try again.'
    );
  });

  it('surfaces a refused change', async () => {
    const { run } = runner({ 'serve --https=443 off': new Error('access denied') });
    expect(await setTailscaleServe(7462, false, run)).toEqual({
      success: false,
      error: { type: 'failed', message: 'access denied' },
    });
  });
});
