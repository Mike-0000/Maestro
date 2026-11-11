import { describe, expect, it } from 'vitest';
import { composerPlaceholder } from './composer-placeholder';

describe('composerPlaceholder', () => {
  it('asks what the developer wants when idle or before any status', () => {
    const idle = 'Tell the conductor what you want from this task';
    expect(composerPlaceholder({ ready: true, busy: false, state: 'idle' })).toBe(idle);
    expect(composerPlaceholder({ ready: true, busy: false, state: null })).toBe(idle);
  });

  it('says a message waits for the turn while the conductor works', () => {
    expect(composerPlaceholder({ ready: true, busy: true, state: 'needs_you' })).toBe(
      'Write to the conductor. It is sent when this turn ends.'
    );
  });

  it('offers a check-in while agents work', () => {
    expect(composerPlaceholder({ ready: true, busy: false, state: 'working' })).toBe(
      "Ask how it's going, or redirect the work"
    );
  });

  it('asks for an answer when the conductor needs the developer', () => {
    expect(composerPlaceholder({ ready: true, busy: false, state: 'needs_you' })).toBe(
      'Answer, or tell the conductor what to do'
    );
  });

  it('asks what is next when the work is done', () => {
    expect(composerPlaceholder({ ready: true, busy: false, state: 'done' })).toBe(
      "Ask for a change, or say what's next"
    );
  });

  it('says the conductor is off when it is not ready, whatever else holds', () => {
    expect(composerPlaceholder({ ready: false, busy: true, state: 'working' })).toBe(
      'The conductor is off'
    );
  });
});
