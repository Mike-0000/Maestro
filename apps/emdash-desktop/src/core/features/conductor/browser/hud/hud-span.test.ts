import { describe, expect, it } from 'vitest';
import { FULL_WINDOW_SPAN, hudSpanFor } from './hud-span';

describe('hudSpanFor', () => {
  it('insets the HUD to the content panel beside the sidebar', () => {
    expect(hudSpanFor({ left: 288, right: 1440, width: 1152 }, 1440)).toEqual({
      left: 288,
      right: 0,
    });
  });

  it('rounds to whole pixels', () => {
    expect(hudSpanFor({ left: 287.6, right: 1439.4, width: 1151.8 }, 1440)).toEqual({
      left: 288,
      right: 1,
    });
  });

  it('uses the whole window for a panel that is not laid out', () => {
    expect(hudSpanFor({ left: 0, right: 0, width: 0 }, 1440)).toBe(FULL_WINDOW_SPAN);
  });

  it('never leaves the HUD less than nothing to stand in', () => {
    expect(hudSpanFor({ left: 1500, right: 1600, width: 100 }, 1440)).toBe(FULL_WINDOW_SPAN);
  });

  it('clamps a panel that reaches past the window edges', () => {
    expect(hudSpanFor({ left: -10, right: 1460, width: 1470 }, 1440)).toEqual({
      left: 0,
      right: 0,
    });
  });
});
