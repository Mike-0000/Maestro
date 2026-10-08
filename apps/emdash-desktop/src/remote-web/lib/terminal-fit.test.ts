import { describe, expect, it } from 'vitest';
import {
  clampFontSize,
  fitFontSize,
  gridForArea,
  MAX_FIT_FONT_SIZE,
  MIN_FONT_SIZE,
  pinchFontSize,
} from './terminal-fit';

describe('fitFontSize', () => {
  it('shrinks the font until a wide host terminal fits a phone', () => {
    const size = fitFontSize({ availableWidth: 374, cols: 120, cellWidthRatio: 0.6 });
    expect(size).toBe(5);
    expect(120 * 0.6 * size).toBeLessThanOrEqual(374);
  });

  it('never rounds up past the available width', () => {
    const size = fitFontSize({ availableWidth: 400, cols: 100, cellWidthRatio: 0.6 });
    expect(size).toBe(6.5);
    expect(100 * 0.6 * size).toBeLessThanOrEqual(400);
  });

  it('does not blow a narrow terminal up past a comfortable reading size', () => {
    expect(fitFontSize({ availableWidth: 1600, cols: 40, cellWidthRatio: 0.6 })).toBe(
      MAX_FIT_FONT_SIZE
    );
  });

  it('bottoms out at the minimum instead of becoming invisible', () => {
    expect(fitFontSize({ availableWidth: 320, cols: 400, cellWidthRatio: 0.6 })).toBe(
      MIN_FONT_SIZE
    );
    expect(fitFontSize({ availableWidth: 0, cols: 80, cellWidthRatio: 0.6 })).toBe(MIN_FONT_SIZE);
  });
});

describe('gridForArea', () => {
  it('counts whole cells', () => {
    expect(gridForArea({ width: 374, height: 500, cellWidth: 7.2, cellHeight: 15 })).toEqual({
      cols: 51,
      rows: 33,
    });
  });

  it('keeps a usable minimum grid', () => {
    expect(gridForArea({ width: 50, height: 20, cellWidth: 7.2, cellHeight: 15 })).toEqual({
      cols: 20,
      rows: 6,
    });
    expect(gridForArea({ width: 300, height: 300, cellWidth: 0, cellHeight: 0 })).toEqual({
      cols: 20,
      rows: 6,
    });
  });
});

describe('font size limits', () => {
  it('clamps', () => {
    expect(clampFontSize(1)).toBe(4);
    expect(clampFontSize(99)).toBe(28);
    expect(clampFontSize(Number.NaN)).toBe(4);
  });

  it('scales with a pinch in quarter-pixel steps', () => {
    expect(pinchFontSize(8, 1.5)).toBe(12);
    expect(pinchFontSize(8, 1.01)).toBe(8);
    expect(pinchFontSize(8, 0.1)).toBe(4);
    expect(pinchFontSize(8, 0)).toBe(8);
  });
});
