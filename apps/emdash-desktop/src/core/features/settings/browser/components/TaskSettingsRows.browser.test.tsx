import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { setHostPlatformForTesting } from '@core/primitives/client-mode/browser/host-platform';
import { EnableTmuxRow } from './TaskSettingsRows';

const mocks = vi.hoisted(() => ({ getPlatform: vi.fn() }));

vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { tmuxByDefault: true },
    update: vi.fn(),
    isLoading: false,
    isSaving: false,
    isFieldOverridden: () => false,
    resetField: vi.fn(),
  }),
}));

vi.mock('@core/primitives/keybindings/api', () => ({
  detectPlatformContext: () => ({ os: 'mac' }),
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ getPlatform: mocks.getPlatform }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('EnableTmuxRow platform', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    setHostPlatformForTesting(undefined);
    mocks.getPlatform.mockResolvedValue('win32');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
    setHostPlatformForTesting(undefined);
  });

  it('reads this computer in local mode and never asks a host', async () => {
    setClientModeForTesting(false);

    await act(async () => root.render(<EnableTmuxRow />));

    expect(container.textContent).toContain('Run agent sessions and terminals in tmux');
    expect(mocks.getPlatform).not.toHaveBeenCalled();
  });

  it("follows the remote host's platform in client mode", async () => {
    setClientModeForTesting(true);

    await act(async () => root.render(<EnableTmuxRow />));

    await vi.waitFor(() =>
      expect(container.textContent).toContain('tmux is unavailable for Windows sessions')
    );
    expect(mocks.getPlatform).toHaveBeenCalledTimes(1);
  });
});
