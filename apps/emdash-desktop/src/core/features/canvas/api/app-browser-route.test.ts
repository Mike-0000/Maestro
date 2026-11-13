import { describe, expect, it } from 'vitest';
import { routeAppBrowserRequest, type AppBrowserRouteInput } from './app-browser-route';

const sharedTab = { browserId: 'tab-1', isolated: false, control: 'user' as const, inFront: true };
const agentTab = { browserId: 'tab-2', isolated: true, control: 'agents' as const, inFront: true };

function input(overrides: Partial<AppBrowserRouteInput> = {}): AppBrowserRouteInput {
  return {
    access: 'control',
    requestedBrowserId: null,
    canvasBrowserId: 'tile-1',
    taskViewTabs: [],
    taskViewOnScreen: false,
    ...overrides,
  };
}

describe('routeAppBrowserRequest', () => {
  it("serves the developer's task view tab beside the chat, not the canvas tile", () => {
    // The laptop case: conductor on the left, the developer's browser tab on the right.
    expect(
      routeAppBrowserRequest(
        input({ requestedBrowserId: 'tab-1', taskViewTabs: [sharedTab], taskViewOnScreen: true })
      )
    ).toEqual({ kind: 'task-tab', browserId: 'tab-1', handOver: true, isolate: true });
  });

  it('uses a tab already handed to agents without asking', () => {
    expect(
      routeAppBrowserRequest(input({ requestedBrowserId: 'tab-2', taskViewTabs: [agentTab] }))
    ).toEqual({ kind: 'task-tab', browserId: 'tab-2', handOver: false, isolate: false });
  });

  it('picks the tab in front when main named none yet (the tab was never registered)', () => {
    const behind = { ...agentTab, browserId: 'tab-3', inFront: false };
    expect(
      routeAppBrowserRequest(input({ taskViewTabs: [behind, sharedTab], taskViewOnScreen: true }))
    ).toMatchObject({ kind: 'task-tab', browserId: 'tab-1' });
  });

  it('opens a new tab beside the chat when the developer is in the task view without one', () => {
    expect(routeAppBrowserRequest(input({ taskViewOnScreen: true }))).toEqual({
      kind: 'new-task-tab',
    });
    expect(
      routeAppBrowserRequest(input({ canvasBrowserId: null, taskViewOnScreen: true }))
    ).toEqual({ kind: 'new-task-tab' });
  });

  it('keeps the canvas tile when that is what the developer looked at last', () => {
    expect(
      routeAppBrowserRequest(
        input({ requestedBrowserId: 'tile-1', taskViewTabs: [sharedTab], taskViewOnScreen: true })
      )
    ).toEqual({ kind: 'canvas' });
  });

  it('uses the canvas when the developer is not in the task view', () => {
    expect(routeAppBrowserRequest(input())).toEqual({ kind: 'canvas' });
    expect(routeAppBrowserRequest(input({ canvasBrowserId: null }))).toEqual({ kind: 'canvas' });
  });

  it('only watches what exists: never opens or hands over for observe', () => {
    expect(
      routeAppBrowserRequest(
        input({ access: 'observe', requestedBrowserId: 'tab-2', taskViewTabs: [agentTab] })
      )
    ).toEqual({ kind: 'task-tab', browserId: 'tab-2', handOver: false, isolate: false });
    expect(routeAppBrowserRequest(input({ access: 'observe', taskViewOnScreen: true }))).toEqual({
      kind: 'canvas',
    });
    expect(routeAppBrowserRequest(input({ access: 'observe', canvasBrowserId: null }))).toEqual({
      kind: 'none',
    });
  });
});
