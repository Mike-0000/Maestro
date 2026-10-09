import { describe, expect, it } from 'vitest';
import { viewportRect } from './canvas-model';
import { clampPaneCount, livePane, paneBoxes, paneGrid, splitViewport } from './canvas-panes';

describe('paneGrid', () => {
  it('puts two and three views side by side and four in quadrants', () => {
    expect(paneGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(paneGrid(2)).toEqual({ columns: 2, rows: 1 });
    expect(paneGrid(3)).toEqual({ columns: 3, rows: 1 });
    expect(paneGrid(4)).toEqual({ columns: 2, rows: 2 });
  });

  it('clamps the number of views', () => {
    expect(clampPaneCount(0)).toBe(1);
    expect(clampPaneCount(9)).toBe(4);
    expect(clampPaneCount(Number.NaN)).toBe(1);
  });
});

describe('paneBoxes', () => {
  it('fills the surface, leaving only the dividers', () => {
    const boxes = paneBoxes(4, { width: 1601, height: 901 });
    expect(boxes).toEqual([
      { x: 0, y: 0, w: 800, h: 450 },
      { x: 801, y: 0, w: 800, h: 450 },
      { x: 0, y: 451, w: 800, h: 450 },
      { x: 801, y: 451, w: 800, h: 450 },
    ]);
  });
});

describe('splitViewport', () => {
  it('continues one picture across the views', () => {
    const surface = { width: 1601, height: 901 };
    const viewport = { x: 80, y: -40, zoom: 0.5 };
    const boxes = paneBoxes(4, surface);
    const whole = viewportRect(viewport, surface);
    const parts = splitViewport(viewport, boxes).map((part, index) => {
      const box = boxes[index];
      return viewportRect(part, { width: box?.w ?? 0, height: box?.h ?? 0 });
    });
    // The first view starts where the single canvas did; the last ends where it did.
    expect(parts[0]).toMatchObject({ x: whole.x, y: whole.y });
    const last = parts[3];
    expect((last?.x ?? 0) + (last?.w ?? 0)).toBeCloseTo(whole.x + whole.w);
    expect((last?.y ?? 0) + (last?.h ?? 0)).toBeCloseTo(whole.y + whole.h);
    expect(parts.every((part) => part.w === 1600 && part.h === 900)).toBe(true);
  });
});

describe('livePane', () => {
  const views = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 50, y: 0, w: 100, h: 100 },
    { x: 500, y: 0, w: 100, h: 100 },
  ];
  const tile = { x: 60, y: 10, w: 20, h: 20 };

  it('prefers the active view when the window shows there', () => {
    expect(livePane(tile, views, 1)).toBe(1);
    expect(livePane(tile, views, 0)).toBe(0);
  });

  it('falls back to the first view showing the window', () => {
    expect(livePane(tile, views, 2)).toBe(0);
  });

  it('falls back to the active view when no view shows it', () => {
    expect(livePane({ x: 900, y: 900, w: 10, h: 10 }, views, 2)).toBe(2);
  });
});
