import { describe, expect, it } from 'vitest';
import {
  AGENT_TILE_SIZE,
  assignSpokenName,
  boundsOf,
  browsersToSuspend,
  FRAME_HEADER,
  FRAME_PADDING,
  frameRect,
  GLYPH_ZOOM_THRESHOLD,
  isInteractiveZoom,
  isLegacySpokenName,
  nextFreeAnchor,
  placeTiles,
  rectContains,
  rectsOverlap,
  resolveBrowserTileMode,
  TILE_GAP,
  viewportRect,
  zoomBand,
  type TileRect,
} from './canvas-model';
import { spokenProviderLabel } from './provider-names';

describe('isInteractiveZoom', () => {
  it('accepts only zoom within 2 % of 1', () => {
    expect(isInteractiveZoom(1)).toBe(true);
    expect(isInteractiveZoom(0.985)).toBe(true);
    expect(isInteractiveZoom(1.019)).toBe(true);
    expect(isInteractiveZoom(0.9)).toBe(false);
    expect(isInteractiveZoom(1.2)).toBe(false);
  });
});

describe('zoomBand', () => {
  it('splits glyph, scaled overview, and interactive zoom', () => {
    expect(zoomBand(0.2)).toBe('glyph');
    expect(zoomBand(0.6)).toBe('scaled');
    expect(zoomBand(1)).toBe('interactive');
  });
});

describe('placeTiles', () => {
  it('lays out a grid from the anchor without overlaps', () => {
    const rects = placeTiles([], 4, AGENT_TILE_SIZE, { x: 0, y: 0 }, 3);
    expect(rects).toHaveLength(4);
    expect(rects[0]).toMatchObject({ x: 0, y: 0 });
    expect(rects[3]?.y).toBeGreaterThan(0);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i] as TileRect, rects[j] as TileRect)).toBe(false);
      }
    }
  });

  it('skips slots taken by existing tiles', () => {
    const existing: TileRect[] = [{ x: 0, y: 0, ...AGENT_TILE_SIZE }];
    const [rect] = placeTiles(existing, 1, AGENT_TILE_SIZE, { x: 0, y: 0 });
    expect(rect).toBeDefined();
    expect(rectsOverlap(rect as TileRect, existing[0] as TileRect)).toBe(false);
  });
});

describe('geometry helpers', () => {
  it('computes bounds and the next free anchor to the right', () => {
    const rects: TileRect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 200, y: 50, w: 100, h: 100 },
    ];
    expect(boundsOf(rects)).toEqual({ x: 0, y: 0, w: 300, h: 150 });
    expect(boundsOf([])).toBeNull();
    expect(nextFreeAnchor(rects).x).toBeGreaterThan(300);
    expect(nextFreeAnchor([])).toEqual({ x: 0, y: 0 });
  });

  it('converts a viewport to canvas coordinates', () => {
    expect(viewportRect({ x: -100, y: -50, zoom: 0.5 }, { width: 800, height: 600 })).toEqual({
      x: 200,
      y: 100,
      w: 1600,
      h: 1200,
    });
  });
});

describe('spoken names', () => {
  it('assigns the first free roster name across the canvas', () => {
    expect(assignSpokenName(undefined, [])).toBe('Atlas');
    expect(assignSpokenName(undefined, ['Atlas', 'Auth'])).toBe('Bravo');
    expect(assignSpokenName(undefined, ['Bravo'])).toBe('Atlas');
    expect(assignSpokenName(undefined, ['atlas', 'Claude 1'])).toBe('Bravo');
  });

  it('keeps the conversation title when it is a free roster name', () => {
    expect(assignSpokenName('Cedar', ['Atlas'])).toBe('Cedar');
    expect(assignSpokenName('cedar', [])).toBe('Cedar');
  });

  it('falls back to a free roster name when the title is taken or not a roster name', () => {
    // Every task's first window is titled "Atlas"; the canvas still needs distinct names.
    expect(assignSpokenName('Atlas', ['Atlas'])).toBe('Bravo');
    expect(assignSpokenName('Claude (1)', [])).toBe('Atlas');
    expect(assignSpokenName('Fix login flow', ['Atlas'])).toBe('Bravo');
  });

  it('recognises names generated before roster names', () => {
    expect(isLegacySpokenName('Claude 1', 'Claude')).toBe(true);
    expect(isLegacySpokenName('codex 12', 'Codex')).toBe(true);
    expect(isLegacySpokenName('Claude 1', 'Codex')).toBe(false);
    expect(isLegacySpokenName('Claude', 'Claude')).toBe(false);
    expect(isLegacySpokenName('Reviewer', 'Claude')).toBe(false);
    expect(isLegacySpokenName('Kilo 2', 'Kilo')).toBe(false);
  });

  it('uses short provider labels', () => {
    expect(spokenProviderLabel('claude')).toBe('Claude');
    expect(spokenProviderLabel('opencode')).toBe('OpenCode');
    expect(spokenProviderLabel('some-new_agent')).toBe('Some new agent');
  });
});

describe('frameRect', () => {
  it('wraps tiles with padding and a header, staying inside the tile gap', () => {
    const frame = frameRect([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 148, y: 0, w: 100, h: 50 },
    ]);
    expect(frame).toEqual({
      x: -FRAME_PADDING,
      y: -FRAME_PADDING - FRAME_HEADER,
      w: 248 + FRAME_PADDING * 2,
      h: 50 + FRAME_PADDING * 2 + FRAME_HEADER,
    });
    expect(FRAME_PADDING * 2 + FRAME_HEADER).toBeLessThanOrEqual(TILE_GAP);
    expect(frameRect([])).toBeNull();
  });
});

describe('app browser tiles', () => {
  it('is live only at interactive zoom, fully visible and alive', () => {
    expect(resolveBrowserTileMode({ zoom: 1, fullyVisible: true, alive: true })).toBe('live');
    expect(resolveBrowserTileMode({ zoom: 1, fullyVisible: false, alive: true })).toBe('snapshot');
    expect(resolveBrowserTileMode({ zoom: 1, fullyVisible: true, alive: false })).toBe('snapshot');
    expect(resolveBrowserTileMode({ zoom: 0.5, fullyVisible: true, alive: true })).toBe('snapshot');
    expect(
      resolveBrowserTileMode({ zoom: GLYPH_ZOOM_THRESHOLD / 2, fullyVisible: true, alive: true })
    ).toBe('glyph');
  });

  it('checks containment with a small tolerance', () => {
    const outer = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectContains(outer, { x: 10, y: 10, w: 50, h: 50 })).toBe(true);
    expect(rectContains(outer, { x: -0.5, y: 0, w: 100.5, h: 100 })).toBe(true);
    expect(rectContains(outer, { x: 60, y: 0, w: 50, h: 50 })).toBe(false);
  });

  it('suspends the least recently used idle browsers over budget, never leased ones', () => {
    const lastUsed = new Map([
      ['a', 1],
      ['b', 3],
      ['c', 2],
      ['d', 0],
    ]);
    expect(
      browsersToSuspend({ alive: ['a', 'b', 'c', 'd'], lastUsed, leased: new Set(), budget: 2 })
    ).toEqual(['a', 'd']);
    expect(
      browsersToSuspend({
        alive: ['a', 'b', 'c', 'd'],
        lastUsed,
        leased: new Set(['d']),
        budget: 2,
      })
    ).toEqual(['c', 'a']);
    expect(
      browsersToSuspend({ alive: ['a', 'b'], lastUsed, leased: new Set(['a', 'b']), budget: 1 })
    ).toEqual([]);
  });
});
