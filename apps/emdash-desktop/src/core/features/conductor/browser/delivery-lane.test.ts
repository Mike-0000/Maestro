import { describe, expect, it } from 'vitest';
import type { DeveloperTyping } from '@core/features/terminals/api/browser/pty/developer-typing';
import { AFTER_SUBMIT_IDLE_MS, TYPING_IDLE_MS, typingHoldReason } from './delivery-lane';

const typing = (overrides: Partial<DeveloperTyping> = {}): DeveloperTyping => ({
  lastKeystrokeAt: 0,
  lastKeyWasSubmit: false,
  lastSubmitAt: null,
  draft: 'empty',
  unsentText: false,
  ...overrides,
});

describe('typingHoldReason', () => {
  it('sends when nothing was typed there', () => {
    expect(typingHoldReason(null, 1_000)).toBeNull();
  });

  it('holds while keys are recent, and releases after the quiet', () => {
    expect(typingHoldReason(typing(), TYPING_IDLE_MS - 1)).toBe('typing');
    expect(typingHoldReason(typing(), TYPING_IDLE_MS)).toBeNull();
  });

  it('releases sooner after Enter', () => {
    const submitted = typing({ lastKeyWasSubmit: true, lastSubmitAt: 0 });
    expect(typingHoldReason(submitted, AFTER_SUBMIT_IDLE_MS - 1)).toBe('typing');
    expect(typingHoldReason(submitted, AFTER_SUBMIT_IDLE_MS)).toBeNull();
  });

  it('holds an unknown draft only by typing recency', () => {
    const unknown = typing({ draft: 'unknown' });
    expect(typingHoldReason(unknown, TYPING_IDLE_MS - 1)).toBe('typing');
    expect(typingHoldReason(unknown, TYPING_IDLE_MS)).toBeNull();
  });

  it('keeps holding over text left unsent, however old', () => {
    expect(typingHoldReason(typing({ draft: 'text', unsentText: true }), 60 * 60_000)).toBe(
      'unsent-text'
    );
    expect(
      typingHoldReason(typing({ lastKeystrokeAt: null, draft: 'text', unsentText: true }), 1)
    ).toBe('unsent-text');
  });
});
