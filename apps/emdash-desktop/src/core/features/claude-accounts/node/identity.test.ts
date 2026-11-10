import { describe, expect, it } from 'vitest';
import { parseClaudeAuthStatus } from './identity';

describe('parseClaudeAuthStatus', () => {
  it('reads email and plan from a signed-in report', () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"pro"}',
        0
      )
    ).toEqual({ loggedIn: true, email: 'a@b.c', plan: 'pro' });
  });

  it('falls back to the older nested account shape and to the exit code', () => {
    expect(parseClaudeAuthStatus('{"oauthAccount":{"emailAddress":"a@b.c"}}', 0)).toEqual({
      loggedIn: true,
      email: 'a@b.c',
    });
    expect(parseClaudeAuthStatus('{"authMethod":"none"}', 1)).toEqual({ loggedIn: false });
  });

  it('drops identity from a signed-out report', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false,"email":"stale@b.c"}', 1)).toEqual({
      loggedIn: false,
    });
  });

  it('is null for output that is not a report', () => {
    expect(parseClaudeAuthStatus('Not logged in', 1)).toBeNull();
    expect(parseClaudeAuthStatus('[]', 0)).toBeNull();
  });
});
