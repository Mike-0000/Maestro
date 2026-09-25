import { describe, expect, it } from 'vitest';
import { CONFIRM_KEY_GRACE_MS, isTextEntryTarget, pendingKeyAction } from './pending-keys';

const body = { tagName: 'BODY', closest: () => null };
const later = CONFIRM_KEY_GRACE_MS + 1;

function press(key: string, overrides: Record<string, unknown> = {}) {
  return { key, shiftKey: false, repeat: false, isComposing: false, target: body, ...overrides };
}

describe('pendingKeyAction', () => {
  it('confirms on a deliberate Enter and cancels on Escape', () => {
    expect(pendingKeyAction(press('Enter'), 0, later)).toBe('confirm');
    expect(pendingKeyAction(press('Escape'), 0, 0)).toBe('cancel');
    expect(pendingKeyAction(press('a'), 0, later)).toBeNull();
  });

  it('ignores Enter typed into a terminal or text field', () => {
    const xtermInput = { tagName: 'TEXTAREA', closest: () => ({}) };
    const insideXterm = {
      tagName: 'DIV',
      closest: (selector: string) => (selector.includes('.xterm') ? {} : null),
    };
    expect(pendingKeyAction(press('Enter', { target: xtermInput }), 0, later)).toBeNull();
    expect(pendingKeyAction(press('Enter', { target: insideXterm }), 0, later)).toBeNull();
    expect(pendingKeyAction(press('Enter', { target: { tagName: 'INPUT' } }), 0, later)).toBeNull();
  });

  it('ignores Enter right after the action appears, on repeat, with shift, or mid-IME', () => {
    expect(pendingKeyAction(press('Enter'), 1000, 1000 + CONFIRM_KEY_GRACE_MS - 1)).toBeNull();
    expect(pendingKeyAction(press('Enter', { repeat: true }), 0, later)).toBeNull();
    expect(pendingKeyAction(press('Enter', { shiftKey: true }), 0, later)).toBeNull();
    expect(pendingKeyAction(press('Enter', { isComposing: true }), 0, later)).toBeNull();
  });
});

describe('isTextEntryTarget', () => {
  it('recognises editable elements', () => {
    expect(isTextEntryTarget({ isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'select' })).toBe(true);
    expect(isTextEntryTarget(body)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
