import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { setHostPlatformForTesting } from '@core/primitives/client-mode/browser/host-platform';
import { HostSettingsCard } from './host-settings-card';

const mocks = vi.hoisted(() => ({ getPlatform: vi.fn() }));

vi.mock('../use-host-settings', () => ({
  useHostSettings: () => ({
    settings: { tmux: true },
    parseError: null,
    isLoading: false,
    update: vi.fn(),
  }),
}));

vi.mock('../../contributions/app-stores', () => ({
  getMachinesStore: () => ({ connections: [] }),
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

const SUPPORTED = 'Run sessions on this host inside tmux';
const UNSUPPORTED = 'tmux is not available for Windows sessions';

describe('HostSettingsCard tmux support', () => {
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

  it("decides this computer's defaults from this computer in local mode", async () => {
    setClientModeForTesting(false);

    await act(async () => root.render(<HostSettingsCard />));

    expect(container.textContent).toContain(SUPPORTED);
    expect(mocks.getPlatform).not.toHaveBeenCalled();
  });

  it("decides them from the remote host's platform in client mode", async () => {
    setClientModeForTesting(true);

    await act(async () => root.render(<HostSettingsCard />));

    await vi.waitFor(() => expect(container.textContent).toContain(UNSUPPORTED));
  });

  it('leaves another machine supported in client mode', async () => {
    setClientModeForTesting(true);
    setHostPlatformForTesting('win32');

    await act(async () => root.render(<HostSettingsCard machineId="ssh-1" />));

    expect(container.textContent).toContain(SUPPORTED);
  });
});
