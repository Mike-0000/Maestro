import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { CodeCheckFolders } from './chorus-settings-page';

const mocks = vi.hoisted(() => ({
  openSelectDirectoryDialog: vi.fn(),
  openDirectorySelectorModal: vi.fn(),
  checkInvestigationFolder: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../../contributions/browser/app-stores', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConductorStore: () => ({
    settings: { investigationFolders: [] },
    updateSettings: mocks.updateSettings,
  }),
}));

vi.mock('../../api/browser/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConductorClient: async () => ({ checkInvestigationFolder: mocks.checkInvestigationFolder }),
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHostClient: async () => ({ openSelectDirectoryDialog: mocks.openSelectDirectoryDialog }),
}));

vi.mock('@core/manifests/browser/modal-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOpenModal: () => mocks.openDirectorySelectorModal,
}));

vi.mock('@core/features/projects/api/browser/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectsWireClient: vi.fn(),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('CodeCheckFolders folder picker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.openSelectDirectoryDialog.mockResolvedValue('C:\\work\\docs');
    mocks.openDirectorySelectorModal.mockResolvedValue({
      success: true,
      data: { path: '/home/dev/docs' },
    });
    mocks.checkInvestigationFolder.mockImplementation(async ({ path }: { path: string }) => ({
      ok: true,
      path,
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
  });

  async function addFolder() {
    await act(async () => root.render(<CodeCheckFolders />));
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Add folder')
    );
    await act(async () => button!.click());
    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled());
  }

  it('opens the native folder dialog in local mode', async () => {
    setClientModeForTesting(false);

    await addFolder();

    expect(mocks.openSelectDirectoryDialog).toHaveBeenCalledWith({
      title: 'Add a folder for code checks',
      message: 'Choose a folder the conductor may read but not change.',
    });
    expect(mocks.openDirectorySelectorModal).not.toHaveBeenCalled();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ investigationFolders: ['C:\\work\\docs'] });
  });

  it("browses the host's folders in client mode", async () => {
    setClientModeForTesting(true);

    await addFolder();

    expect(mocks.openSelectDirectoryDialog).not.toHaveBeenCalled();
    expect(mocks.openDirectorySelectorModal).toHaveBeenCalledWith({
      strategy: 'local',
      getProjectsClient: getProjectsWireClient,
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      investigationFolders: ['/home/dev/docs'],
    });
  });
});
