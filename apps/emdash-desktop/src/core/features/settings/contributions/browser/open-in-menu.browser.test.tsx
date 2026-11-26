import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { OpenInMenu } from './open-in-menu';

const mocks = vi.hoisted(() => ({ register: vi.fn(() => () => undefined) }));

vi.mock('@core/features/settings/api/browser/useOpenInApps', () => ({
  useOpenInApps: () => ({
    icons: {},
    labels: { vscode: 'VS Code' },
    installedApps: [{ id: 'vscode', label: 'VS Code', supportsRemote: true }],
    availability: { vscode: true },
    platform: 'win32',
    loading: false,
  }),
}));

vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: { default: 'vscode' }, update: vi.fn() }),
}));

vi.mock('@core/features/settings/browser/components/OpenInAppIcon', () => ({
  OpenInAppIcon: () => <span />,
}));

vi.mock('@core/primitives/keybindings/browser/shortcut', () => ({
  BoundShortcut: () => null,
}));

vi.mock('@core/primitives/open-in-apps/browser/open-in-command-registry', () => ({
  openInCommandRegistry: { register: mocks.register },
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ openIn: vi.fn() }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('OpenInMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
  });

  it('offers this computer’s apps in local mode', async () => {
    setClientModeForTesting(false);

    await act(async () => root.render(<OpenInMenu path="/Users/me/app" />));

    expect(container.querySelector('[aria-label="Open in VS Code"]')).not.toBeNull();
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it('is hidden in client mode, where projects are on the remote host', async () => {
    setClientModeForTesting(true);

    await act(async () => root.render(<OpenInMenu path="/home/dev/app" />));

    expect(container.innerHTML).toBe('');
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
