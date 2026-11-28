import { describe, expect, it } from 'vitest';
import { extractLoginUrl } from './auth';

describe('extractLoginUrl', () => {
  it('stops at the terminal escapes around an OSC 8 hyperlink', () => {
    const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';
    const chunk =
      "If the browser didn't open, visit:\r\n" +
      `\x1b]8;;${url}\x07\x1b[94m${url}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;
    expect(extractLoginUrl(chunk)).toBe(url);
  });

  it('finds a plain URL and trims trailing punctuation', () => {
    expect(extractLoginUrl('Open https://example.com/login. Then wait')).toBe(
      'https://example.com/login'
    );
  });

  it('returns null when there is no URL', () => {
    expect(extractLoginUrl('Waiting for sign-in…')).toBeNull();
  });
});
