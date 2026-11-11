import '@emdash/ui/style.css';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkspacePresetPicker } from './workspace-preset-picker';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('WorkspacePresetPicker', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  // The closed picker is one field line with the preset's name (the redesign moved each
  // preset's sentence into the open list); the label must fit without clipping.
  it('shows the preset label in a field line without clipping it', async () => {
    await act(async () => {
      root.render(
        <WorkspacePresetPicker
          value="new-worktree"
          onValueChange={() => {}}
          hasPR={false}
          hasExistingWorkspaces={false}
        />
      );
    });

    const trigger = host.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain('Create new worktree');
    expect(trigger!.getBoundingClientRect().height).toBeGreaterThanOrEqual(28);
    expect(trigger!.scrollHeight).toBeLessThanOrEqual(trigger!.clientHeight);
  });
});
