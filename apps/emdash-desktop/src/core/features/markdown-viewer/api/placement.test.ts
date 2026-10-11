import { describe, expect, it } from 'vitest';
import { placeMarkdown, placementMessage } from './placement';

const source = { projectId: 'p1', taskId: 't1' };

describe('placeMarkdown', () => {
  it('opens a canvas window while the canvas is on screen', () => {
    expect(placeMarkdown({ kind: 'canvas' }, source)).toEqual({ surface: 'canvas' });
  });

  it("opens beside the agent in its own task's view", () => {
    expect(placeMarkdown({ kind: 'task', projectId: 'p1', taskId: 't1' }, source)).toEqual({
      surface: 'task',
      projectId: 'p1',
      taskId: 't1',
      navigate: false,
    });
  });

  it('opens in the task on screen when another task sent the file', () => {
    expect(placeMarkdown({ kind: 'task', projectId: 'p2', taskId: 't9' }, source)).toEqual({
      surface: 'task',
      projectId: 'p2',
      taskId: 't9',
      navigate: false,
    });
  });

  it("goes to the agent's task view from a view that holds no agent windows", () => {
    expect(placeMarkdown({ kind: 'other' }, source)).toEqual({
      surface: 'task',
      projectId: 'p1',
      taskId: 't1',
      navigate: true,
    });
  });
});

describe('placementMessage', () => {
  it('tells the agent where the file went', () => {
    expect(placementMessage('plan.md', { surface: 'canvas' })).toBe(
      'Opened plan.md for the developer in a window on the canvas.'
    );
    expect(
      placementMessage('plan.md', { surface: 'task', projectId: 'p', taskId: 't', navigate: false })
    ).toBe('Opened plan.md for the developer in a pane beside the agent.');
  });
});
