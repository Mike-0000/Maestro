import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { DirectoryField } from './local-directory-selector';
import type { ProjectDirectoryPickerClient } from './project-directory-picker';

const mocks = vi.hoisted(() => ({
  openDirectorySelectorModal: vi.fn(),
  openSelectDirectoryDialog: vi.fn(),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.openDirectorySelectorModal,
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ openSelectDirectoryDialog: mocks.openSelectDirectoryDialog }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('DirectoryField for local projects', () => {
  let container: HTMLDivElement;
  let root: Root;
  const getProjectsClient = vi.fn<() => Promise<ProjectDirectoryPickerClient>>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openSelectDirectoryDialog.mockResolvedValue('/Users/me/app');
    mocks.openDirectorySelectorModal.mockResolvedValue({
      success: true,
      data: { path: '/home/dev/app' },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
  });

  async function chooseFolder(onPathChange: (path: string) => void) {
    await act(async () => {
      root.render(
        <DirectoryField
          strategy="local"
          title="Select a local project"
          message="Select a project directory to open"
          path="/start"
          ensureDefaultRoot
          getProjectsClient={getProjectsClient}
          onPathChange={onPathChange}
        />
      );
    });
    await act(async () => {
      container.querySelector('button')!.click();
    });
  }

  it('opens the native folder dialog in local mode', async () => {
    setClientModeForTesting(false);
    const onPathChange = vi.fn();

    await chooseFolder(onPathChange);

    expect(mocks.openSelectDirectoryDialog).toHaveBeenCalledWith({
      title: 'Select a local project',
      message: 'Select a project directory to open',
    });
    expect(mocks.openDirectorySelectorModal).not.toHaveBeenCalled();
    expect(onPathChange).toHaveBeenCalledWith('/Users/me/app');
  });

  it("browses the host's folders in client mode", async () => {
    setClientModeForTesting(true);
    const onPathChange = vi.fn();

    await chooseFolder(onPathChange);

    expect(mocks.openSelectDirectoryDialog).not.toHaveBeenCalled();
    expect(mocks.openDirectorySelectorModal).toHaveBeenCalledWith({
      strategy: 'local',
      initialPath: '/start',
      ensureDefaultRoot: true,
      getProjectsClient,
    });
    expect(onPathChange).toHaveBeenCalledWith('/home/dev/app');
  });
});
