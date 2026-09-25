import { describe, expect, it } from 'vitest';
import { evaluateNavigation, originKey, SlidingWindowLimiter } from './control-policy';

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
