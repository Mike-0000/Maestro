import { describe, expect, it } from 'vitest';
import { wireUrlFor } from '../lib/wire-link';
import { parseRoute, routePath, type Route } from './router';

describe('routes', () => {
  it('parses the deep links the host serves the shell for', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/agent/conv-1')).toEqual({ name: 'agent', conversationId: 'conv-1' });
    expect(parseRoute('/agent/conv-1/')).toEqual({ name: 'agent', conversationId: 'conv-1' });
    expect(parseRoute('/new')).toEqual({ name: 'new' });
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
  });

  it('falls back to home for anything it does not know', () => {
    expect(parseRoute('/agent')).toEqual({ name: 'home' });
    expect(parseRoute('/nope/at/all')).toEqual({ name: 'home' });
  });

  it('round-trips conversation ids that need encoding', () => {
    const route: Route = { name: 'agent', conversationId: 'a/b c%' };
    expect(routePath(route)).toBe('/agent/a%2Fb%20c%25');
    expect(parseRoute(routePath(route))).toEqual(route);
  });

  it('tolerates a malformed escape instead of throwing', () => {
    expect(parseRoute('/agent/%E0%A4%A')).toEqual({ name: 'agent', conversationId: '%E0%A4%A' });
  });
});

describe('wireUrlFor', () => {
  it('matches the page scheme', () => {
    expect(wireUrlFor({ protocol: 'https:', host: 'pc.tailnet.ts.net' })).toBe(
      'wss://pc.tailnet.ts.net/wire'
    );
    expect(wireUrlFor({ protocol: 'http:', host: '127.0.0.1:7462' })).toBe(
      'ws://127.0.0.1:7462/wire'
    );
  });
});
