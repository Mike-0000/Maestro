import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { setHostPlatformForTesting } from '@core/primitives/client-mode/browser/host-platform';
import { MachinesSettingsPage } from './machines-settings-page';

const mocks = vi.hoisted(() => ({ getPlatform: vi.fn() }));

vi.mock('@core/features/machines/contributions/app-stores', () => ({
  getMachinesStore: () => ({ connections: [], stateFor: () => 'disconnected' }),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => vi.fn(),
}));

vi.mock('../machines-list-model', () => ({
  createMachinesListView: () => ({
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    useSearch: () => ({ query: '', setQuery: vi.fn() }),
  }),
}));

vi.mock('../components/machine-list-row', () => ({ MachineListRow: () => null }));

vi.mock('@emdash/ui/react/patterns', () => ({
  PageLayout: { Header: () => null },
  CollectionView: ({ toolbar }: { toolbar: ReactNode }) => <>{toolbar}</>,
  CollectionToolbar: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Search: () => null,
    Spacer: () => null,
    Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));

vi.mock('@emdash/ui/react/primitives', () => ({
  toast: { error: vi.fn() },
  SplitButton: ({ options }: { options: { id: string; label: string }[] }) => (
    <ul>
      {options.map((option) => (
        <li key={option.id}>{option.label}</li>
      ))}
    </ul>
  ),
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ getPlatform: mocks.getPlatform }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('MachinesSettingsPage WSL option', () => {
  let container: HTMLDivElement;
  let root: Root;

  function setUserAgent(value: string) {
    Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
  }

  async function renderPage() {
    await act(async () => root.render(<MachinesSettingsPage openDetail={vi.fn()} />));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setHostPlatformForTesting(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, 'userAgent');
    setClientModeForTesting(undefined);
    setHostPlatformForTesting(undefined);
  });

  it('follows this computer in local mode', async () => {
    setClientModeForTesting(false);
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await renderPage();
    expect(container.textContent).toContain('Add WSL distro');

    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');
    await renderPage();
    expect(container.textContent).not.toContain('Add WSL distro');
    expect(mocks.getPlatform).not.toHaveBeenCalled();
  });

  it('follows the remote host in client mode', async () => {
    setClientModeForTesting(true);
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    mocks.getPlatform.mockResolvedValue('linux');
    await renderPage();
    await vi.waitFor(() => expect(mocks.getPlatform).toHaveBeenCalled());
    expect(container.textContent).not.toContain('Add WSL distro');
  });

  it('offers WSL when the remote host is Windows', async () => {
    setClientModeForTesting(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');
    mocks.getPlatform.mockResolvedValue('win32');
    await renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain('Add WSL distro'));
  });
});
