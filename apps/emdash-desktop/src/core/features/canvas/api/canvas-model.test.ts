import { describe, expect, it } from 'vitest';
import {
  AGENT_TILE_SIZE,
  assignSpokenName,
  boundsOf,
  FRAME_HEADER,
  FRAME_PADDING,
  frameRect,
  GLYPH_ZOOM_THRESHOLD,
  isInteractiveZoom,
  nextFreeAnchor,
  placeTiles,
  rectsOverlap,
  resolveTileDetail,
  TILE_GAP,
  viewportRect,
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

describe('resolveTileDetail', () => {
  const base = { zoom: 1, visible: true, focusRank: 0, liveBudget: 6, hasSession: true };

  it('renders a glyph when zoomed far out, regardless of focus', () => {
    expect(resolveTileDetail({ ...base, zoom: GLYPH_ZOOM_THRESHOLD - 0.01 })).toBe('glyph');
  });

  it('keeps recently focused visible tiles live within the budget', () => {
    expect(resolveTileDetail({ ...base, focusRank: 5 })).toBe('live');
    expect(resolveTileDetail({ ...base, focusRank: 6 })).toBe('preview');
  });

  it('falls back to preview offscreen or without a session', () => {
    expect(resolveTileDetail({ ...base, visible: false })).toBe('preview');
    expect(resolveTileDetail({ ...base, hasSession: false })).toBe('preview');
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
  it('assigns the lowest free number per provider', () => {
    expect(assignSpokenName('Claude', [])).toBe('Claude 1');
    expect(assignSpokenName('Claude', ['Claude 1', 'Codex 1'])).toBe('Claude 2');
    expect(assignSpokenName('Claude', ['Claude 2'])).toBe('Claude 1');
    expect(assignSpokenName('Codex', ['codex 1', 'Auth'])).toBe('Codex 2');
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
