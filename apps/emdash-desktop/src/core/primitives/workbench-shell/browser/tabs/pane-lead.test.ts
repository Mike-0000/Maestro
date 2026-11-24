import { afterEach, describe, expect, it } from 'vitest';
import { createTabRegistry } from './core/tab-provider-registry';
import { PaneStore } from './pane-store';

const panes: PaneStore[] = [];

afterEach(() => {
  for (const pane of panes.splice(0)) pane.dispose();
});

function setup() {
  const registry = createTabRegistry([
    {
      kind: 'test',
      resourceKey: (state: { id: string }) => state.id,
      initialize: () => ({ dispose() {} }),
      dispose() {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    },
  ]);
  const pane = new PaneStore(registry, { viewId: 'test-view' });
  panes.push(pane);
  pane.open('test', { id: 'first' });
  pane.open('test', { id: 'second' });
  const [first, second] = pane.tabOrder;
  if (!first || !second) throw new Error('Missing test tabs');
  return { pane, first, second };
}

describe('pinned lead', () => {
  it('covers the tabs without changing which one is active', () => {
    const { pane, second } = setup();
    pane.setLeadActive(true);
    expect(pane.leadActive).toBe(true);
    expect(pane.activeTabId).toBe(second);
  });

  it('steps back when the already active tab is chosen', () => {
    const { pane, second } = setup();
    pane.setLeadActive(true);
    pane.setActiveTab(second);
    expect(pane.leadActive).toBe(false);
  });

  it('steps back when another tab is chosen, opened or reached by keyboard', () => {
    const { pane, first } = setup();
    pane.setLeadActive(true);
    pane.setActiveTab(first);
    expect(pane.leadActive).toBe(false);

    pane.setLeadActive(true);
    pane.open('test', { id: 'third' });
    expect(pane.leadActive).toBe(false);

    pane.setLeadActive(true);
    pane.setNextTabActive();
    expect(pane.leadActive).toBe(false);
  });
});
