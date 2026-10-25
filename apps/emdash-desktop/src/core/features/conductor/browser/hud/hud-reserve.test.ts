import { describe, expect, it } from 'vitest';
import { hudReservePx } from './hud-reserve';

describe('hudReservePx', () => {
  it('adds the collapsed padding, border, gap, and bottom offset to the row height', () => {
    // 36px row + 12px p-1.5 + 2px border + 8px gap + 16px bottom-4.
    expect(hudReservePx({ rowHeight: 36, bottomOffset: 16, remPx: 16 })).toBe(74);
  });

  it('scales the rem-based chrome with the root font size', () => {
    expect(hudReservePx({ rowHeight: 36, bottomOffset: 20, remPx: 20 })).toBe(36 + 2 + 25 + 20);
  });

  it('rounds up to whole pixels', () => {
    expect(hudReservePx({ rowHeight: 36.4, bottomOffset: 16, remPx: 16 })).toBe(75);
  });

  it('reserves nothing when the row is not laid out', () => {
    expect(hudReservePx({ rowHeight: 0, bottomOffset: 16, remPx: 16 })).toBe(0);
    expect(hudReservePx({ rowHeight: Number.NaN, bottomOffset: 16, remPx: 16 })).toBe(0);
  });
});
