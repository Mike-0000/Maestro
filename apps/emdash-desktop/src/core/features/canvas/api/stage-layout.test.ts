import { describe, expect, it } from 'vitest';
import {
  EMPTY_STAGE,
  fitsMinimums,
  leafOrder,
  moveSplitter,
  pageKey,
  pageSizeFor,
  paneInDirection,
  paneShare,
  reorder,
  scalePane,
  stageOrder,
  stageView,
  swapInOrder,
  templateTree,
} from './stage-layout';

const area = { x: 0, y: 0, w: 1920, h: 1000 };
const ids = (n: number, kind = 'agent') => Array.from({ length: n }, (_, i) => `${kind}:${i}`);

describe('stage templates', () => {
  it('produces one pane per window in pane order', () => {
    for (let n = 1; n <= 9; n++) {
      const tree = templateTree(ids(n), area.w / area.h);
      expect(leafOrder(tree)).toEqual(ids(n));
    }
  });

  it('puts two windows side by side on landscape and stacked on portrait', () => {
    const landscape = templateTree(ids(2), 1.8);
    expect(landscape).toMatchObject({ type: 'split', axis: 'row' });
    const portrait = templateTree(ids(2), 0.8);
    expect(portrait).toMatchObject({ type: 'split', axis: 'column' });
  });

  it('weights browsers wider', () => {
    const tree = templateTree(['browser:a', 'agent:b'], 1.8);
    expect(paneShare(tree!, 'browser:a')).toBeCloseTo(0.6);
  });

  it('paginates when panes would drop below minimum size', () => {
    const small = { x: 0, y: 0, w: 1000, h: 600 };
    const size = pageSizeFor(ids(9), small);
    expect(size).toBeLessThan(9);
    expect(fitsMinimums(templateTree(ids(size), small.w / small.h), small)).toBe(true);
    const view = stageView(ids(9), EMPTY_STAGE, small, 1);
    expect(view.pageCount).toBe(Math.ceil(9 / size));
    expect(view.panes.every((pane) => pane.rect.w >= 360 && pane.rect.h >= 220)).toBe(true);
  });

  it('keeps an adjusted tree while the page holds the same windows', () => {
    const view = stageView(ids(2), EMPTY_STAGE, area, 0);
    const adjusted = moveSplitter(view.tree!, [], 0, 0.2);
    const saved = { ...EMPTY_STAGE, trees: { [pageKey(ids(2))]: adjusted } };
    expect(stageView(ids(2), saved, area, 0).adjusted).toBe(true);
    expect(stageView(ids(3), saved, area, 0).adjusted).toBe(false);
  });

  it('solos one window', () => {
    const view = stageView(ids(3), { ...EMPTY_STAGE, soloTileId: 'agent:1' }, area, 0);
    expect(view.panes.map((pane) => pane.tileId)).toEqual(['agent:1']);
  });
});

describe('stage edits', () => {
  it('scales a pane within its split and clamps', () => {
    const tree = templateTree(ids(2), 1.8)!;
    const bigger = scalePane(tree, 'agent:0', 1.25);
    expect(paneShare(bigger, 'agent:0')).toBeCloseTo(0.625);
    let huge = tree;
    for (let i = 0; i < 20; i++) huge = scalePane(huge, 'agent:0', 1.5);
    expect(paneShare(huge, 'agent:0')).toBeLessThan(0.9);
  });

  it('reorders and swaps panes', () => {
    expect(reorder(['a', 'b', 'c'], 'c', 'first')).toEqual(['c', 'a', 'b']);
    expect(reorder(['a', 'b', 'c'], 'a', 'last')).toEqual(['b', 'c', 'a']);
    expect(swapInOrder(['a', 'b', 'c'], 'a', 'c')).toEqual(['c', 'b', 'a']);
    expect(stageOrder(['c', 'x'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('finds the pane in a direction', () => {
    const view = stageView(ids(4), EMPTY_STAGE, area, 0);
    expect(paneInDirection(view.panes, 'agent:0', 'right')).toBe('agent:1');
    expect(paneInDirection(view.panes, 'agent:0', 'down')).toBe('agent:2');
    expect(paneInDirection(view.panes, 'agent:0', 'left')).toBeNull();
  });
});
