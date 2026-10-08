import { describe, expect, it } from 'vitest';
import {
  maestroHostAddress,
  maestroHostHeaders,
  maestroHostInfoUrl,
  maestroHostPairUrl,
  maestroHostWireUrl,
  normalizeMaestroHostUrl,
} from './endpoint';

function normalized(input: string): string {
  const result = normalizeMaestroHostUrl(input);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

describe('normalizeMaestroHostUrl', () => {
  it('keeps scheme, host, and port and drops a trailing slash', () => {
    expect(normalized('https://my-pc.tailnet.ts.net/')).toBe('https://my-pc.tailnet.ts.net');
    expect(normalized('  http://127.0.0.1:7462  ')).toBe('http://127.0.0.1:7462');
  });

  it('defaults a bare address to https, and loopback to http', () => {
    expect(normalized('my-pc.tailnet.ts.net')).toBe('https://my-pc.tailnet.ts.net');
    expect(normalized('my-pc.tailnet.ts.net:8443')).toBe('https://my-pc.tailnet.ts.net:8443');
    expect(normalized('localhost:7462')).toBe('http://localhost:7462');
    expect(normalized('127.0.0.1:7462')).toBe('http://127.0.0.1:7462');
  });

  it('lower-cases the host and drops default ports, query, and fragment', () => {
    expect(normalized('HTTPS://My-PC.Example.com:443/?x=1#top')).toBe('https://my-pc.example.com');
  });

  it('keeps a reverse-proxy path prefix', () => {
    expect(normalized('https://example.com/maestro/')).toBe('https://example.com/maestro');
  });

  it('accepts a WebSocket address as its HTTP origin', () => {
    expect(normalized('wss://example.com')).toBe('https://example.com');
    expect(normalized('ws://127.0.0.1:7462')).toBe('http://127.0.0.1:7462');
  });

  it('rejects empty, malformed, non-HTTP, and credential-bearing addresses', () => {
    for (const input of ['', '   ', 'https://', 'ftp://example.com', 'https://me:pw@example.com']) {
      expect(normalizeMaestroHostUrl(input)).toMatchObject({
        success: false,
        error: { type: 'invalid-url' },
      });
    }
  });
});

describe('Maestro host endpoints', () => {
  it('derives the HTTP API addresses', () => {
    expect(maestroHostInfoUrl('http://127.0.0.1:7462')).toBe('http://127.0.0.1:7462/api/info');
    expect(maestroHostPairUrl('https://example.com/maestro')).toBe(
      'https://example.com/maestro/api/pair'
    );
  });

  it('derives the Wire address with the matching WebSocket scheme', () => {
    expect(maestroHostWireUrl('http://127.0.0.1:7462')).toBe('ws://127.0.0.1:7462/wire');
    expect(maestroHostWireUrl('https://example.com/maestro')).toBe(
      'wss://example.com/maestro/wire'
    );
  });

  it('reports the host name and effective port', () => {
    expect(maestroHostAddress('https://example.com')).toEqual({ host: 'example.com', port: 443 });
    expect(maestroHostAddress('http://example.com')).toEqual({ host: 'example.com', port: 80 });
    expect(maestroHostAddress('http://127.0.0.1:7462')).toEqual({ host: '127.0.0.1', port: 7462 });
  });
});

describe('maestroHostHeaders', () => {
  it('sends nothing without credentials', () => {
    expect(maestroHostHeaders()).toEqual({});
  });

  it('sends the device token as a bearer credential', () => {
    expect(maestroHostHeaders({ token: 'tok' })).toEqual({ Authorization: 'Bearer tok' });
  });

  it('adds the Cloudflare Access service token to every request', () => {
    expect(
      maestroHostHeaders({ cfAccess: { clientId: 'id.access', clientSecret: 'shh' } })
    ).toEqual({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'shh' });
    expect(
      maestroHostHeaders({
        token: 'tok',
        cfAccess: { clientId: 'id.access', clientSecret: 'shh' },
      })
    ).toEqual({
      Authorization: 'Bearer tok',
      'CF-Access-Client-Id': 'id.access',
      'CF-Access-Client-Secret': 'shh',
    });
  });
});
