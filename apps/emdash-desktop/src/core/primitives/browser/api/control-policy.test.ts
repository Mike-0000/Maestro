import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  describeNavigationDenial,
  evaluateNavigation,
  evaluatePublicUrl,
  originKey,
  SlidingWindowLimiter,
} from './control-policy';

const policy = {
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:54321'],
  reservedPorts: [40111, 40222],
};

describe('originKey', () => {
  it('treats loopback aliases as one origin', () => {
    const key = originKey('http://localhost:5173/app');
    expect(originKey('http://127.0.0.1:5173/')).toBe(key);
    expect(originKey('http://[::1]:5173')).toBe(key);
    expect(originKey('http://0.0.0.0:5173')).toBe(key);
  });

  it('distinguishes scheme and port, and fills default ports', () => {
    expect(originKey('http://localhost:5173')).not.toBe(originKey('https://localhost:5173'));
    expect(originKey('http://localhost:5173')).not.toBe(originKey('http://localhost:5174'));
    expect(originKey('https://example.com')).toBe('https://example.com:443');
  });

  it('rejects non-http urls', () => {
    expect(originKey('file:///C:/secret.txt')).toBeNull();
    expect(originKey('not a url')).toBeNull();
  });
});

describe('evaluateNavigation', () => {
  it('allows the dev-server origin and its loopback aliases', () => {
    expect(evaluateNavigation('http://localhost:5173/login', policy)).toEqual({ ok: true });
    expect(evaluateNavigation('http://127.0.0.1:5173/', policy)).toEqual({ ok: true });
    expect(evaluateNavigation('http://localhost:54321/rest', policy)).toEqual({ ok: true });
    expect(evaluateNavigation('about:blank', policy)).toEqual({ ok: true });
  });

  it('denies other origins and ports', () => {
    expect(evaluateNavigation('https://example.com', policy)).toMatchObject({
      reason: 'origin-not-allowed',
    });
    expect(evaluateNavigation('http://localhost:5174', policy)).toMatchObject({
      reason: 'origin-not-allowed',
    });
    expect(evaluateNavigation('http://192.168.1.10:5173', policy)).toMatchObject({
      reason: 'origin-not-allowed',
    });
  });

  it('denies Chorus ports even when an allowlist entry matches', () => {
    const permissive = { ...policy, allowedOrigins: ['http://localhost:40111'] };
    expect(evaluateNavigation('http://127.0.0.1:40111/hook', permissive)).toMatchObject({
      reason: 'reserved-port',
    });
  });

  it('denies file and other protocols', () => {
    expect(evaluateNavigation('file:///C:/Windows/win.ini', policy)).toMatchObject({
      reason: 'unsupported-protocol',
    });
    expect(evaluateNavigation('javascript:alert(1)', policy)).toMatchObject({
      reason: 'unsupported-protocol',
    });
    expect(evaluateNavigation('::::', policy)).toMatchObject({ reason: 'invalid-url' });
  });
});

describe('SlidingWindowLimiter', () => {
  it('limits hits per key within the window', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 1_000, () => now);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    expect(limiter.tryAcquire('b')).toBe(true);
    now = 1_000;
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('forgets keys by prefix', () => {
    const limiter = new SlidingWindowLimiter(1, 1_000, () => 0);
    limiter.tryAcquire('browser-1:act');
    limiter.forget('browser-1');
    expect(limiter.tryAcquire('browser-1:act')).toBe(true);
  });
});

describe('classifyHost', () => {
  const hostOf = (url: string) => new URL(url).hostname;

  it('recognizes loopback and public hosts', () => {
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost(hostOf('http://[::1]:3000'))).toBe('loopback');
    expect(classifyHost('example.com')).toBe('public');
    expect(classifyHost('Docs.Example.COM.')).toBe('public');
    expect(classifyHost('93.184.216.34')).toBe('public');
    expect(classifyHost(hostOf('https://[2606:4700::1111]/'))).toBe('public');
  });

  it('treats private, link-local and reserved addresses as private', () => {
    for (const host of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '127.0.0.2',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(classifyHost(host), host).toBe('private');
    }
    expect(classifyHost('172.32.0.1')).toBe('public');
    expect(classifyHost('100.128.0.1')).toBe('public');
  });

  it('sees through alternate IPv4 spellings once the URL is parsed', () => {
    expect(classifyHost(hostOf('http://2130706433/'))).toBe('loopback');
    expect(classifyHost(hostOf('http://0xA9FEA9FE/'))).toBe('private');
    expect(classifyHost(hostOf('http://0300.0250.1.1/'))).toBe('private');
  });

  it('treats non-global IPv6 literals as private', () => {
    for (const url of [
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:8.8.8.8]/',
      'http://[64:ff9b::a00:1]/',
      'http://[ff02::1]/',
    ]) {
      expect(classifyHost(hostOf(url)), url).toBe('private');
    }
  });

  it('treats single-label and intranet names as private', () => {
    for (const host of ['intranet', 'nas.local', 'db.internal', 'app.localhost', 'x.home.arpa']) {
      expect(classifyHost(host), host).toBe('private');
    }
  });
});

describe('evaluatePublicUrl', () => {
  it('admits https URLs on public hosts and reports their origin', () => {
    expect(evaluatePublicUrl('https://Example.com/docs?q=1#top')).toEqual({
      ok: true,
      origin: 'https://example.com',
    });
    expect(evaluatePublicUrl('https://example.com:8443/')).toEqual({
      ok: true,
      origin: 'https://example.com:8443',
    });
  });

  it('refuses everything else with a specific reason', () => {
    expect(evaluatePublicUrl('not a url')).toEqual({ ok: false, reason: 'invalid-url' });
    expect(evaluatePublicUrl('example.com')).toEqual({ ok: false, reason: 'invalid-url' });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
      expect(evaluatePublicUrl(url), url).toEqual({ ok: false, reason: 'unsupported-protocol' });
    }
    expect(evaluatePublicUrl('http://example.com/')).toEqual({
      ok: false,
      reason: 'insecure-public-url',
    });
    expect(evaluatePublicUrl('https://user:pw@example.com/')).toEqual({
      ok: false,
      reason: 'embedded-credentials',
    });
    for (const url of [
      'https://localhost:3000/',
      'https://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'https://router.local/',
      // The userinfo trick: the real host is the private one.
      'https://example.com@10.0.0.1/',
    ]) {
      expect(evaluatePublicUrl(url), url).toEqual({ ok: false, reason: 'not-public-host' });
    }
  });
});

describe('evaluateNavigation with public websites', () => {
  const approved = { ...policy, publicWeb: { approvedOrigins: ['https://example.com'] } };

  it('keeps public sites closed to actors without public web (coding agents)', () => {
    expect(evaluateNavigation('https://example.com/', policy)).toEqual({
      ok: false,
      reason: 'origin-not-allowed',
    });
  });

  it('allows only the origins the user approved', () => {
    expect(evaluateNavigation('https://example.com/docs', approved)).toEqual({ ok: true });
    expect(evaluateNavigation('https://EXAMPLE.com:443/', approved)).toEqual({ ok: true });
    for (const url of [
      'https://www.example.com/',
      'https://example.com.evil.net/',
      'https://example.com:8443/',
    ]) {
      expect(evaluateNavigation(url, approved), url).toEqual({
        ok: false,
        reason: 'public-origin-not-approved',
      });
    }
  });

  it('refuses unsafe forms of an approved site', () => {
    expect(evaluateNavigation('http://example.com/', approved)).toMatchObject({
      reason: 'insecure-public-url',
    });
    expect(evaluateNavigation('https://a:b@example.com/', approved)).toMatchObject({
      reason: 'embedded-credentials',
    });
  });

  it('never admits private hosts through an approval', () => {
    const sloppy = {
      ...policy,
      publicWeb: { approvedOrigins: ['https://192.168.1.1', 'http://169.254.169.254'] },
    };
    expect(evaluateNavigation('https://192.168.1.1/', sloppy)).toMatchObject({
      reason: 'origin-not-allowed',
    });
    expect(evaluateNavigation('http://169.254.169.254/', sloppy)).toMatchObject({
      reason: 'origin-not-allowed',
    });
  });

  it('reports the setting when it is off, and still protects reserved ports', () => {
    const disabled = { ...policy, publicWeb: 'disabled' as const };
    const decision = evaluateNavigation('https://example.com/', disabled);
    expect(decision).toEqual({ ok: false, reason: 'public-web-disabled' });
    if (!decision.ok) {
      expect(describeNavigationDenial(decision, 'https://example.com/')).toContain('turned off');
    }
    expect(evaluateNavigation('http://localhost:40111/', approved)).toMatchObject({
      reason: 'reserved-port',
    });
    expect(evaluateNavigation('http://localhost:5173/', disabled)).toEqual({ ok: true });
  });
});
