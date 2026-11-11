import { describe, expect, it } from 'vitest';
import { decideBrowserUrl, type BrowserUrlContext } from './browser-policy';

const developer = (words: string, publicWebEnabled = true): BrowserUrlContext => ({
  trigger: 'developer',
  developerWords: words,
  devServerOrigins: ['http://localhost:5173'],
  publicWebEnabled,
});
const event: BrowserUrlContext = {
  trigger: 'event',
  developerWords: null,
  devServerOrigins: ['http://localhost:5173'],
  publicWebEnabled: true,
};

describe('decideBrowserUrl', () => {
  it("opens the task's dev servers on any turn", () => {
    expect(decideBrowserUrl('http://localhost:5173/login', event)).toEqual({
      ok: true,
      url: 'http://localhost:5173/login',
    });
    expect(decideBrowserUrl('localhost:5173', developer('show me the app'))).toMatchObject({
      ok: true,
    });
  });

  it('opens another address on this computer only when the developer names it', () => {
    expect(decideBrowserUrl('http://localhost:9229', event).ok).toBe(false);
    expect(decideBrowserUrl('http://127.0.0.1:9229', developer('open the app')).ok).toBe(false);
    expect(
      decideBrowserUrl('http://localhost:8080/admin', developer('open localhost:8080/admin'))
    ).toEqual({ ok: true, url: 'http://localhost:8080/admin' });
  });

  it('never opens private or internal hosts', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://192.168.1.10',
      'http://printer.local',
      'http://intranet',
    ]) {
      const decision = decideBrowserUrl(url, developer(`open ${url}`));
      expect(decision.ok).toBe(false);
    }
  });

  it('opens a public site only on a developer turn, with the setting on, when they name it', () => {
    expect(
      decideBrowserUrl('https://docs.stripe.com/api', developer('check docs.stripe.com for that'))
    ).toEqual({ ok: true, url: 'https://docs.stripe.com/api' });
    expect(
      decideBrowserUrl('https://www.example.com', developer('open example.com'))
    ).toMatchObject({ ok: true });
    const unnamed = decideBrowserUrl('https://evil.example', developer('find the docs'));
    expect(unnamed).toMatchObject({ ok: false });
    expect(!unnamed.ok && unnamed.reason).toContain("developer's own message names it");
    const off = decideBrowserUrl('https://docs.stripe.com', developer('docs.stripe.com', false));
    expect(!off.ok && off.reason).toContain('public websites are turned off');
    const onEvent = decideBrowserUrl('https://docs.stripe.com', event);
    expect(!onEvent.ok && onEvent.reason).toContain('never on what an agent said');
  });

  it('refuses insecure, credentialed and non-web addresses', () => {
    expect(decideBrowserUrl('http://docs.stripe.com', developer('docs.stripe.com')).ok).toBe(false);
    expect(
      decideBrowserUrl('https://user:pw@docs.stripe.com', developer('docs.stripe.com')).ok
    ).toBe(false);
    expect(decideBrowserUrl('file:///etc/passwd', developer('file:///etc/passwd')).ok).toBe(false);
    expect(decideBrowserUrl('javascript:alert(1)', developer('javascript:alert(1)')).ok).toBe(
      false
    );
  });

  it('lets an empty tab open', () => {
    expect(decideBrowserUrl('about:blank', event)).toEqual({ ok: true, url: 'about:blank' });
  });
});
