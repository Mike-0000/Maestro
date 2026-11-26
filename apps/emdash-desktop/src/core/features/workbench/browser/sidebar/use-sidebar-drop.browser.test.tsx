import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { useSidebarDrop } from './use-sidebar-drop';

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return {
    toast,
    navigate: vi.fn(),
    inspectProjectPath: vi.fn(),
    createProject: vi.fn(),
  };
});

vi.mock('@emdash/ui/react/primitives', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('@core/features/projects/api/browser/client', () => ({
  getProjectsWireClient: async () => ({ inspectProjectPath: mocks.inspectProjectPath }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ createProject: mocks.createProject }),
}));

vi.mock('@core/features/projects/contributions/views', () => ({
  projectViewDef: (params: { projectId: string }) => ({ view: 'project', params }),
}));

vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@core/primitives/drag-files/browser/drag-files', () => ({
  hasDraggedFiles: () => true,
  getDraggedFilePaths: () => ['/Users/me/app'],
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('useSidebarDrop', () => {
  let container: HTMLDivElement;
  let root: Root;
  let drop: ReturnType<typeof useSidebarDrop>['onDrop'];

  function Probe() {
    drop = useSidebarDrop().onDrop;
    return null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.inspectProjectPath.mockResolvedValue({ isDirectory: true });
    mocks.createProject.mockResolvedValue('project-1');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
  });

  function dropEvent() {
    return { preventDefault: vi.fn(), dataTransfer: {} } as unknown as React.DragEvent;
  }

  it('adds a dropped folder as a project in local mode', async () => {
    setClientModeForTesting(false);

    await act(async () => drop(dropEvent()));

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        view: 'project',
        params: { projectId: 'project-1' },
      })
    );
    expect(mocks.inspectProjectPath).toHaveBeenCalledWith({ type: 'local', path: '/Users/me/app' });
    expect(mocks.createProject).toHaveBeenCalledWith(
      { type: 'local' },
      { mode: 'pick', name: 'app', path: '/Users/me/app', initGitRepository: false }
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('explains instead of adding a project in client mode', async () => {
    setClientModeForTesting(true);

    await act(async () => drop(dropEvent()));

    expect(mocks.toast).toHaveBeenCalledWith(
      'Cannot add a folder from this computer',
      expect.objectContaining({ description: expect.stringContaining('Maestro host') })
    );
    expect(mocks.inspectProjectPath).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
