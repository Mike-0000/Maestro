import { describe, expect, it } from 'vitest';
import { focusLine, resolveFocus, type FocusSignals, type WorkbenchView } from './focus';

const NAMES: Record<string, string> = { a: 'Atlas', b: 'Bravo', c: 'Cedar' };
const nameOf = (id: string) => NAMES[id] ?? id;

const CANVAS: WorkbenchView = { kind: 'canvas' };

function signals(overrides: Partial<FocusSignals> = {}): FocusSignals {
  return {
    view: CANVAS,
    canvasAgentId: null,
    stageAgentIds: null,
    region: null,
    taskAgentIds: [],
    ...overrides,
  };
}

function taskView(
  overrides: Partial<Extract<WorkbenchView, { kind: 'task' }>> = {}
): WorkbenchView {
  return {
    kind: 'task',
    projectId: 'p',
    taskId: 't',
    activeChatId: null,
    visibleChatIds: [],
    ...overrides,
  };
}

describe('resolveFocus on the canvas', () => {
  it('is the focused window on the board', () => {
    expect(resolveFocus(signals({ canvasAgentId: 'a' }), nameOf)).toMatchObject({
      agentId: 'a',
      surface: 'canvas',
    });
  });

  it('is nobody when no window is focused', () => {
    expect(resolveFocus(signals(), nameOf)).toMatchObject({ agentId: null, surface: 'canvas' });
  });

  it('keeps the focus but says so when the region in view does not hold it', () => {
    const inside = resolveFocus(
      signals({ canvasAgentId: 'a', region: { name: 'Backend', holdsFocused: true } }),
      nameOf
    );
    expect(inside).toMatchObject({ agentId: 'a', surface: 'canvas' });
    expect(inside.why).toContain('in region Backend');

    const outside = resolveFocus(
      signals({ canvasAgentId: 'a', region: { name: 'Backend', holdsFocused: false } }),
      nameOf
    );
    expect(outside.agentId).toBe('a');
    expect(outside.why).toContain('outside region Backend');
  });

  it('calls the desk in view a desk (Canvas Pro)', () => {
    const desk = { name: 'Review', holdsFocused: true, desk: true };
    expect(resolveFocus(signals({ canvasAgentId: 'a', region: desk }), nameOf).why).toBe(
      'its window is focused, on desk Review'
    );
    expect(resolveFocus(signals({ region: desk }), nameOf).why).toBe(
      'on desk Review, with no agent window focused'
    );
    expect(
      resolveFocus(
        signals({ canvasAgentId: 'a', region: { ...desk, holdsFocused: false } }),
        nameOf
      ).why
    ).toContain('outside desk Review');
  });
});

describe('resolveFocus on the stage', () => {
  it('is the only staged agent, whatever was focused on the board before', () => {
    expect(
      resolveFocus(signals({ canvasAgentId: 'a', stageAgentIds: ['b'] }), nameOf)
    ).toMatchObject({ agentId: 'b', surface: 'stage' });
  });

  it('is the focused pane among several staged agents', () => {
    expect(
      resolveFocus(signals({ canvasAgentId: 'b', stageAgentIds: ['b', 'c'] }), nameOf)
    ).toMatchObject({ agentId: 'b', surface: 'stage' });
  });

  it('never picks between staged agents when the focus is on a window that is not staged', () => {
    const focus = resolveFocus(signals({ canvasAgentId: 'a', stageAgentIds: ['b', 'c'] }), nameOf);
    expect(focus).toMatchObject({ agentId: null, surface: 'stage' });
    expect(focus.why).toContain('Bravo, Cedar');
  });
});

describe('resolveFocus in the task view', () => {
  it('is the chat in front, not the agent focused on the canvas', () => {
    expect(
      resolveFocus(
        signals({
          view: taskView({ activeChatId: 'b', visibleChatIds: ['b'] }),
          canvasAgentId: 'a',
          taskAgentIds: ['b', 'c'],
        }),
        nameOf
      )
    ).toMatchObject({ agentId: 'b', surface: 'task-view' });
  });

  it('falls back to the only chat showing, then to the only agent of the task', () => {
    const split = taskView({ visibleChatIds: ['c'] });
    expect(resolveFocus(signals({ view: split, taskAgentIds: ['b', 'c'] }), nameOf)).toMatchObject({
      agentId: 'c',
      surface: 'task-view',
    });
    expect(resolveFocus(signals({ view: taskView(), taskAgentIds: ['b'] }), nameOf)).toMatchObject({
      agentId: 'b',
      surface: 'task-view',
    });
  });

  it('asks when a file is in front and the task has several agents', () => {
    const focus = resolveFocus(signals({ view: taskView(), taskAgentIds: ['b', 'c'] }), nameOf);
    expect(focus).toMatchObject({ agentId: null, surface: 'task-view' });
    expect(focus.why).toContain('Bravo, Cedar');
  });

  it('asks when two chats show side by side and neither pane is the active one', () => {
    const focus = resolveFocus(
      signals({ view: taskView({ visibleChatIds: ['b', 'c'] }), taskAgentIds: ['b', 'c'] }),
      nameOf
    );
    expect(focus.agentId).toBeNull();
    expect(focus.why).toContain('several chats are showing');
  });

  it('ignores a chat the conductor cannot address', () => {
    expect(
      resolveFocus(
        signals({ view: taskView({ activeChatId: 'x', visibleChatIds: ['x'] }) }),
        nameOf
      )
    ).toMatchObject({ agentId: null, surface: 'task-view' });
  });
});

describe('resolveFocus elsewhere', () => {
  it('is nobody on a view with no agent, even with a canvas focus left behind', () => {
    const view: WorkbenchView = { kind: 'other', viewId: 'settings' };
    const focus = resolveFocus(signals({ view, canvasAgentId: 'a' }), nameOf);
    expect(focus).toMatchObject({ agentId: null, surface: 'none' });
    expect(focusLine(focus, view, nameOf)).toBe(
      'Focused agent: none (settings view: no agent is in front)'
    );
  });
});

describe('focusLine', () => {
  it('names the agent and the surface the reading comes from', () => {
    const view = taskView({ activeChatId: 'b' });
    const focus = resolveFocus(signals({ view, taskAgentIds: ['b'] }), nameOf);
    expect(focusLine(focus, view, nameOf)).toBe(
      'Focused agent: Bravo (task view: its chat is the active tab)'
    );
    expect(focusLine(resolveFocus(signals({ canvasAgentId: 'a' }), nameOf), CANVAS, nameOf)).toBe(
      'Focused agent: Atlas (canvas: its window is focused)'
    );
    expect(focusLine(resolveFocus(signals({ stageAgentIds: ['c'] }), nameOf), CANVAS, nameOf)).toBe(
      'Focused agent: Cedar (canvas stage: it is the only agent on the stage, full screen)'
    );
  });
});
