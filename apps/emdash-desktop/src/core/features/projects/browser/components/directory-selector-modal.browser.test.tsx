import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDirectoryPickerClient } from './add-project-modal/project-directory-picker';
import {
  DirectorySelectorModal,
  type DirectorySelectorModalProps,
} from './directory-selector-modal';

const mocks = vi.hoisted(() => ({
  pickerProps: vi.fn(),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useModalController: () => ({ complete: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('./add-project-modal/project-directory-picker', () => ({
  ProjectDirectoryPicker: (props: {
    strategy: string;
    connectionId?: string;
    homePath: string;
  }) => {
    mocks.pickerProps(props);
    return <div data-testid="picker" />;
  },
}));

vi.mock('@emdash/ui/react/primitives', () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Dialog: { Body: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  Field: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Label: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  },
  Input: () => <input />,
  ModalLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@core/primitives/keybindings/browser/confirm-button', () => ({
  ConfirmButton: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('DirectorySelectorModal targets', () => {
  let container: HTMLDivElement;
  let root: Root;
  const getHostHomeDir = vi.fn();
  const ensureDefaultRepositoriesRoot = vi.fn();
  const getProjectsClient = async () =>
    ({ getHostHomeDir, ensureDefaultRepositoriesRoot }) as unknown as ProjectDirectoryPickerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    getHostHomeDir.mockResolvedValue('/home/dev');
    ensureDefaultRepositoriesRoot.mockResolvedValue({ success: true, data: '/home/dev/repos' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderModal(target: Omit<DirectorySelectorModalProps, 'getProjectsClient'>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DirectorySelectorModal
            {...(target as DirectorySelectorModalProps)}
            getProjectsClient={getProjectsClient}
          />
        </QueryClientProvider>
      );
    });
    await vi.waitFor(() =>
      expect(mocks.pickerProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ homePath: '/home/dev' })
      )
    );
  }

  it('browses an SSH machine by its connection, as before', async () => {
    await renderModal({ connectionId: 'ssh-1', ensureDefaultRoot: true });

    expect(getHostHomeDir).toHaveBeenCalledWith({ type: 'ssh', connectionId: 'ssh-1' });
    expect(ensureDefaultRepositoriesRoot).toHaveBeenCalledWith({
      type: 'ssh',
      connectionId: 'ssh-1',
    });
    expect(mocks.pickerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ strategy: 'ssh', connectionId: 'ssh-1' })
    );
  });

  it('browses the local host when asked for the local strategy', async () => {
    await renderModal({ strategy: 'local' });

    expect(getHostHomeDir).toHaveBeenCalledWith({ type: 'local' });
    expect(ensureDefaultRepositoriesRoot).not.toHaveBeenCalled();
    expect(mocks.pickerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ strategy: 'local', connectionId: undefined })
    );
  });
});
