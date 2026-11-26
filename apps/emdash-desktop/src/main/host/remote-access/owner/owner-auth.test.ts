import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  authorizeOwnerRequest,
  classifyOwnerRequest,
  evaluateOwnerPolicy,
  isLoopbackAddress,
  isTailnetAddress,
  ownerBearerCredential,
} from './owner-auth';

function request(
  headers: Record<string, string | string[]> = {},
  remoteAddress = '127.0.0.1'
): IncomingMessage {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return { headers: lower, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/** What `tailscale serve` sends for a tailnet user. */
const TAILSCALE = {
  'Tailscale-User-Login': 'me@example.com',
  'Tailscale-User-Name': 'Me',
  'X-Forwarded-For': '100.101.102.103',
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-Host': 'vm.tail1234.ts.net',
};

const TAILSCALE_ONLY = { tailscaleOnly: true, allowedLogins: [] };

describe('classifyOwnerRequest', () => {
  it('treats a direct loopback connection without proxy headers as loopback', () => {
    expect(classifyOwnerRequest(request())).toEqual({ via: 'loopback', login: null });
    expect(classifyOwnerRequest(request({}, '::1')).via).toBe('loopback');
    expect(classifyOwnerRequest(request({}, '::ffff:127.0.0.1')).via).toBe('loopback');
  });

  it('recognises tailscale serve by its login header and a tailnet forwarding hop', () => {
    expect(classifyOwnerRequest(request(TAILSCALE))).toEqual({
      via: 'tailscale',
      login: 'me@example.com',
    });
    expect(
      classifyOwnerRequest(request({ ...TAILSCALE, 'X-Forwarded-For': 'fd7a:115c:a1e0::1' })).via
    ).toBe('tailscale');
  });

  it('never trusts headers from a peer that is not loopback', () => {
    expect(classifyOwnerRequest(request(TAILSCALE, '192.168.1.20')).via).toBe('other');
    expect(classifyOwnerRequest(request({}, '100.101.102.103')).via).toBe('other');
  });

  it('does not take a forged login through cloudflared or Funnel for tailscale', () => {
    expect(classifyOwnerRequest(request({ ...TAILSCALE, 'Cf-Connecting-Ip': '1.2.3.4' })).via).toBe(
      'other'
    );
    expect(classifyOwnerRequest(request({ ...TAILSCALE, 'Cf-Ray': 'abc' })).via).toBe('other');
    expect(
      classifyOwnerRequest(request({ ...TAILSCALE, 'Tailscale-Funnel-Request': '?1' })).via
    ).toBe('other');
  });

  it('requires the nearest forwarding hop to be a tailnet address', () => {
    const forged = { ...TAILSCALE, 'X-Forwarded-For': '100.101.102.103, 203.0.113.9' };
    expect(classifyOwnerRequest(request(forged)).via).toBe('other');
    const noHop = { 'Tailscale-User-Login': 'me@example.com' };
    expect(classifyOwnerRequest(request(noHop)).via).toBe('other');
    const appended = { ...TAILSCALE, 'X-Forwarded-For': '203.0.113.9, 100.64.0.1' };
    expect(classifyOwnerRequest(request(appended)).via).toBe('tailscale');
  });

  it('treats any other relayed loopback request as other', () => {
    expect(classifyOwnerRequest(request({ 'X-Forwarded-For': '203.0.113.9' })).via).toBe('other');
    expect(classifyOwnerRequest(request({ Forwarded: 'for=203.0.113.9' })).via).toBe('other');
    expect(classifyOwnerRequest(request({ 'Cf-Connecting-Ip': '203.0.113.9' })).via).toBe('other');
    // A login header with an empty value is not a tailnet identity, nor a direct connection.
    expect(classifyOwnerRequest(request({ 'Tailscale-User-Login': ' ' })).via).toBe('other');
  });
});

describe('evaluateOwnerPolicy', () => {
  it('admits only tailscale and loopback when tailscale-only', () => {
    expect(evaluateOwnerPolicy({ via: 'loopback', login: null }, TAILSCALE_ONLY)).toBeNull();
    expect(evaluateOwnerPolicy({ via: 'tailscale', login: 'a@b' }, TAILSCALE_ONLY)).toBeNull();
    expect(evaluateOwnerPolicy({ via: 'other', login: null }, TAILSCALE_ONLY)).toBe(
      'tailscale-required'
    );
  });

  it('admits other tunnels when tailscale-only is off', () => {
    const policy = { tailscaleOnly: false, allowedLogins: [] };
    expect(evaluateOwnerPolicy({ via: 'other', login: null }, policy)).toBeNull();
  });

  it('narrows tailnet users to the allowlist, case-insensitively', () => {
    const policy = { tailscaleOnly: true, allowedLogins: ['Me@Example.com'] };
    expect(evaluateOwnerPolicy({ via: 'tailscale', login: 'me@example.com' }, policy)).toBeNull();
    expect(evaluateOwnerPolicy({ via: 'tailscale', login: 'you@example.com' }, policy)).toBe(
      'login-not-allowed'
    );
    expect(evaluateOwnerPolicy({ via: 'loopback', login: null }, policy)).toBeNull();
  });
});

describe('authorizeOwnerRequest', () => {
  it('refuses any request that carries an Origin, before anything else', () => {
    expect(
      authorizeOwnerRequest(request({ Origin: 'http://127.0.0.1:7462' }), TAILSCALE_ONLY)
    ).toEqual({ ok: false, reason: 'origin-forbidden' });
    expect(
      authorizeOwnerRequest(request({ ...TAILSCALE, Origin: 'https://evil.example' }), {
        tailscaleOnly: false,
        allowedLogins: [],
      })
    ).toEqual({ ok: false, reason: 'origin-forbidden' });
  });

  it('returns the context of an admitted request', () => {
    expect(authorizeOwnerRequest(request(TAILSCALE), TAILSCALE_ONLY)).toEqual({
      ok: true,
      context: { via: 'tailscale', login: 'me@example.com' },
    });
    expect(
      authorizeOwnerRequest(request({ 'X-Forwarded-For': '203.0.113.9' }), TAILSCALE_ONLY)
    ).toEqual({ ok: false, reason: 'tailscale-required' });
  });
});

describe('helpers', () => {
  it('reads only a well-formed bearer credential', () => {
    expect(ownerBearerCredential(request({ Authorization: 'Bearer abc.def' }))).toBe('abc.def');
    expect(ownerBearerCredential(request({ Authorization: 'bearer  abc ' }))).toBe('abc');
    expect(ownerBearerCredential(request({ Authorization: 'Basic abc' }))).toBeUndefined();
    expect(ownerBearerCredential(request({ Authorization: 'Bearer a b' }))).toBeUndefined();
    expect(ownerBearerCredential(request({ Cookie: 'maestro_device=x.y' }))).toBeUndefined();
  });

  it('knows loopback and tailnet addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.8.9.10')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);

    expect(isTailnetAddress('100.64.0.0')).toBe(true);
    expect(isTailnetAddress('100.127.255.255')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.0')).toBe(false);
    expect(isTailnetAddress('::ffff:100.100.1.1')).toBe(true);
    expect(isTailnetAddress('FD7A:115C:A1E0:ab12::1')).toBe(true);
    expect(isTailnetAddress('fd7a:115c:a1e1::1')).toBe(false);
    expect(isTailnetAddress('not-an-ip')).toBe(false);
  });
});
