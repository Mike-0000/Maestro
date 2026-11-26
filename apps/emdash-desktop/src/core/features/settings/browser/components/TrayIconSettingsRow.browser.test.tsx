import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { TrayIconSettingsRow } from './TrayIconSettingsRow';

vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { showTrayIcon: true },
    update: vi.fn(),
    isLoading: false,
    isSaving: false,
    isFieldOverridden: () => false,
    resetField: vi.fn(),
  }),
}));

vi.mock('@core/primitives/keybindings/api', () => ({
  detectPlatformContext: () => ({ os: 'windows' }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('TrayIconSettingsRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
  });

  it('shows the tray switch in local mode', async () => {
    setClientModeForTesting(false);

    await act(async () => root.render(<TrayIconSettingsRow />));

    expect(
      container.querySelector('[aria-label="Show Maestro in the system tray"]')
    ).not.toBeNull();
  });

  it('is hidden in client mode, which has no tray of its own', async () => {
    setClientModeForTesting(true);

    await act(async () => root.render(<TrayIconSettingsRow />));

    expect(container.innerHTML).toBe('');
  });
});
