import { describe, expect, it } from 'vitest';
import {
  isValidTunnelPort,
  ownerDialOptions,
  ownerEndpoints,
  ownerPairUrl,
  ownerTunnelUrl,
  ownerWireUrl,
} from './endpoints';

describe('owner endpoints', () => {
  it('builds every endpoint from a Tailscale address', () => {
    const result = ownerEndpoints('vm.tailnet.ts.net/');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      baseUrl: 'https://vm.tailnet.ts.net',
      pairUrl: 'https://vm.tailnet.ts.net/api/owner/pair',
      pairingCodeUrl: 'https://vm.tailnet.ts.net/api/owner/pairing-code',
      wireUrl: 'wss://vm.tailnet.ts.net/owner/wire',
    });
    expect(result.data.tunnelUrl({ port: 5173, family: 4 })).toBe(
      'wss://vm.tailnet.ts.net/owner/tunnel?port=5173&family=4'
    );
  });

  it('keeps a loopback host on plain http and ws, with its port and path prefix', () => {
    const base = 'http://127.0.0.1:7462/maestro';
    expect(ownerPairUrl(base)).toBe('http://127.0.0.1:7462/maestro/api/owner/pair');
    expect(ownerWireUrl(base)).toBe('ws://127.0.0.1:7462/maestro/owner/wire');
    expect(ownerTunnelUrl(base, { port: 3000, family: 6 })).toBe(
      'ws://127.0.0.1:7462/maestro/owner/tunnel?port=3000&family=6'
    );
    const normalized = ownerEndpoints('localhost:7462');
    expect(normalized.success && normalized.data.wireUrl).toBe('ws://localhost:7462/owner/wire');
  });

  it('passes the normalizer error through for an invalid address', () => {
    const result = ownerEndpoints('ftp://vm');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('invalid-url');
  });

  it('refuses an invalid tunnel target', () => {
    const base = 'https://vm';
    expect(() => ownerTunnelUrl(base, { port: 0, family: 4 })).toThrow(RangeError);
    expect(() => ownerTunnelUrl(base, { port: 65_536, family: 4 })).toThrow(RangeError);
    expect(() => ownerTunnelUrl(base, { port: 80.5, family: 4 })).toThrow(RangeError);
    expect(() => ownerTunnelUrl(base, { port: 80, family: 5 as 4 })).toThrow(RangeError);
    expect(isValidTunnelPort(1)).toBe(true);
    expect(isValidTunnelPort(65_535)).toBe(true);
  });

  it('dials with the bearer token and Cloudflare Access headers, never an Origin', () => {
    const signal = new AbortController().signal;
    const options = ownerDialOptions(
      'wss://vm/owner/wire',
      { token: 'secret', cfAccess: { clientId: 'id', clientSecret: 'cf' } },
      { signal, timeoutMs: 5_000 }
    );
    expect(options).toEqual({
      url: 'wss://vm/owner/wire',
      signal,
      timeoutMs: 5_000,
      headers: {
        Authorization: 'Bearer secret',
        'CF-Access-Client-Id': 'id',
        'CF-Access-Client-Secret': 'cf',
      },
    });
    expect(Object.keys(options.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'origin'
    );
  });
});
