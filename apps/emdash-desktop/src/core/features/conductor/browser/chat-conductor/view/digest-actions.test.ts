import { describe, expect, it } from 'vitest';
import type { ChatDigest } from '../../../api/chat-conductor/digest';
import { digestActions } from './digest-actions';

const digest: ChatDigest = {
  outcome: 'finished',
  headline: 'Hang-up: ready to try, not merged.',
  did: ['Fixed `hangUp()`'],
  status: 'Tests pass.',
  next: 'Try it.',
  asked: 'Fix the hang-up.',
  where: 'Branch `fix/hang-up`, not merged.',
  move: 'Try a call.',
};
const origins = ['http://localhost:5173'];
const actions = (patch: Partial<ChatDigest>, latest = true, canIntegrate = false) =>
  digestActions({
    digest: { ...digest, ...patch },
    latest,
    canIntegrate,
    devServerOrigins: origins,
  });

describe('digestActions', () => {
  it('offers Done only on the newest digest of finished work', () => {
    expect(actions({}).done).toBe(true);
    expect(actions({}, false).done).toBe(false);
    expect(actions({ outcome: 'blocked' }).done).toBe(false);
    expect(actions({ outcome: 'needs_you' }).done).toBe(false);
  });

  it('offers Merge on the newest digest when the task can be integrated', () => {
    expect(actions({}, true, true).merge).toBe(true);
    expect(actions({}, true, false).merge).toBe(false);
    expect(actions({}, false, true).merge).toBe(false);
  });

  it('has no Open app without an address', () => {
    expect(actions({}).openApp).toBe(null);
  });

  it("opens an address on one of the task's dev servers", () => {
    expect(actions({ appUrl: 'http://localhost:5173/settings' }).openApp).toEqual({
      url: 'http://localhost:5173/settings',
    });
    expect(actions({ appUrl: 'http://localhost:5173' }, false).openApp).toEqual({
      url: 'http://localhost:5173/',
    });
  });

  it('refuses a public website, with the reason', () => {
    const openApp = actions({ appUrl: 'https://example.com/login' }).openApp;
    expect(openApp).not.toBe(null);
    expect(openApp && 'refused' in openApp && openApp.refused).toMatch(/public websites/);
  });

  it('refuses another address on this computer and one that is not an address', () => {
    expect(actions({ appUrl: 'http://localhost:9229' }).openApp).toHaveProperty('refused');
    expect(actions({ appUrl: 'javascript:alert(1)' }).openApp).toHaveProperty('refused');
    expect(actions({ appUrl: 'about:blank' }).openApp).toEqual({
      refused: 'There is no page to open.',
    });
  });
});
