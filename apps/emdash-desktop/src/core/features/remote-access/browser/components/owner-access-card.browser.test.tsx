import { err, ok } from '@emdash/shared';
import '@emdash/ui/style.css';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { RemoteAccessStatus } from '@core/features/remote-access/api';
import type { RemoteAccessOwnerAccess } from '@core/features/remote-access/api/contract';

const client = vi.hoisted(() => ({
  setOwnerAccess: vi.fn(),
  createOwnerPairingCode: vi.fn(),
  cancelOwnerPairingCode: vi.fn(),
  revokeDevice: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@core/features/remote-access/api/browser/client', () => ({
  getRemoteAccessClient: async () => client,
}));
vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => vi.fn(async () => ({ success: false })),
}));
vi.mock('@emdash/ui/react/primitives', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast,
}));

import { DevicesCard } from './devices-card';
import { OwnerAccessCard } from './owner-access-card';

const OFF: RemoteAccessOwnerAccess = {
  enabled: false,
  tailscaleOnly: true,
  allowedLogins: [],
  pairing: null,
  attachedClient: null,
};

function status(
  ownerAccess: Partial<RemoteAccessOwnerAccess> = {},
  patch: Partial<RemoteAccessStatus> = {}
): RemoteAccessStatus {
  return {
    enabled: true,
    listening: true,
    port: 7462,
    bindAddress: '127.0.0.1',
    error: null,
    hostName: 'rig-vm',
    webAppAvailable: true,
    devices: [],
    pairing: null,
    triggers: { tokenSet: false, routes: [] },
    ownerAccess: { ...OFF, ...ownerAccess },
    ...patch,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  client.setOwnerAccess.mockResolvedValue(ok(undefined));
  client.cancelOwnerPairingCode.mockResolvedValue(undefined);
  container = document.createElement('div');
  container.style.width = '640px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(value: RemoteAccessStatus | undefined) {
  flushSync(() => root.render(<OwnerAccessCard status={value} />));
}

const toggle = (name: string) => page.getByRole('switch', { name, exact: true });
const button = (name: string) => page.getByRole('button', { name, exact: true });

describe('OwnerAccessCard', () => {
  it('is one switch, off, until it is turned on', async () => {
    render(status());
    await expect.element(toggle('Allow a full-access client')).not.toBeChecked();
    await expect.element(page.getByText('Off', { exact: true })).toBeVisible();
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(client.setOwnerAccess).not.toHaveBeenCalled();
  });

  it('waits for the status before it can be changed', async () => {
    render(undefined);
    await expect.element(toggle('Allow a full-access client')).toBeDisabled();
    await expect.element(page.getByText('Checking…')).toBeVisible();
  });

  it('turns full access on and reports a refusal', async () => {
    render(status());
    await toggle('Allow a full-access client').click();
    await vi.waitFor(() => expect(client.setOwnerAccess).toHaveBeenCalledWith({ enabled: true }));

    client.setOwnerAccess.mockResolvedValueOnce(
      err({ type: 'unavailable', message: 'Not ready yet.' })
    );
    await toggle('Allow a full-access client').click();
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not turn on full access', {
        description: 'Not ready yet.',
      })
    );
  });

  it('shows who may connect once it is on', async () => {
    render(status({ enabled: true, allowedLogins: ['me@example.com'] }));
    await expect.element(toggle('Allow a full-access client')).toBeChecked();
    await expect.element(toggle('Only over Tailscale')).toBeChecked();
    await expect
      .element(page.getByRole('textbox', { name: 'Allowed Tailscale logins' }))
      .toHaveValue('me@example.com');
    await expect.element(page.getByText('No client is connected.')).toBeVisible();

    await toggle('Only over Tailscale').click();
    await vi.waitFor(() =>
      expect(client.setOwnerAccess).toHaveBeenCalledWith({ tailscaleOnly: false })
    );
  });

  it('hides the login list when any tunnel is allowed', async () => {
    render(status({ enabled: true, tailscaleOnly: false }));
    await expect.element(toggle('Only over Tailscale')).not.toBeChecked();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it('applies the allowed logins as a whole list', async () => {
    render(status({ enabled: true }));
    const logins = page.getByRole('textbox', { name: 'Allowed Tailscale logins' });
    await expect.element(button('Apply')).toBeDisabled();
    await logins.fill('me@example.com, Me@Example.com  team@example.com');
    await button('Apply').click();
    await vi.waitFor(() =>
      expect(client.setOwnerAccess).toHaveBeenCalledWith({
        allowedLogins: ['me@example.com', 'team@example.com'],
      })
    );
  });

  it('warns when the listener that carries it is not running', async () => {
    render(status({ enabled: true }, { enabled: false, listening: false }));
    await expect
      .element(page.getByText(/Remote access is not running, so no client can connect/u))
      .toBeVisible();
    await expect.element(button('Create a full-access code')).toBeDisabled();
  });

  it('issues a code, counts it down and cancels it', async () => {
    client.createOwnerPairingCode.mockResolvedValue(
      ok({ code: 'ABCD-EFGH', expiresAt: Date.now() + 5 * 60_000 })
    );
    render(status({ enabled: true }));
    await button('Create a full-access code').click();

    await expect
      .element(page.getByRole('status', { name: 'Full-access pairing code' }))
      .toHaveTextContent('ABCD-EFGH');
    await expect.element(page.getByRole('timer')).toHaveTextContent(/^[45]:\d\d$/u);
    await expect.element(page.getByText('--maestro-client')).toBeVisible();

    await button('Cancel').click();
    await vi.waitFor(() => expect(client.cancelOwnerPairingCode).toHaveBeenCalledOnce());
    await expect.element(button('Create a full-access code')).toBeVisible();
  });

  it('shows the code the live status carries, and why issuing one failed', async () => {
    render(
      status({ enabled: true, pairing: { code: 'WXYZ-1234', expiresAt: Date.now() + 60_000 } })
    );
    await expect
      .element(page.getByRole('status', { name: 'Full-access pairing code' }))
      .toHaveTextContent('WXYZ-1234');

    client.createOwnerPairingCode.mockResolvedValue(
      err({ type: 'unavailable', message: 'Full access is not ready.' })
    );
    render(status({ enabled: true }));
    await button('Create a full-access code').click();
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not create a full-access code', {
        description: 'Full access is not ready.',
      })
    );
  });

  it('names the client that is connected', async () => {
    render(
      status({
        enabled: true,
        attachedClient: {
          deviceId: 'owner-1',
          clientName: 'Desk PC',
          clientPlatform: 'win32',
          since: Date.now() - 60_000,
        },
      })
    );
    await expect.element(page.getByText('Desk PC', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Windows', { exact: true })).toBeVisible();
  });
});

describe('DevicesCard', () => {
  it('marks a full-access client with a badge and leaves other devices as they were', async () => {
    const device = { createdAt: 1_700_000_000_000, lastSeenAt: null, connections: 0 };
    flushSync(() =>
      root.render(
        <DevicesCard
          status={status(
            { enabled: true },
            {
              devices: [
                { ...device, id: 'owner-1', name: 'Desk PC', kind: 'owner', connections: 1 },
                { ...device, id: 'phone-1', name: 'Phone', kind: 'browser' },
                { ...device, id: 'app-1', name: 'Laptop', kind: 'desktop' },
              ],
            }
          )}
        />
      )
    );
    await expect.element(page.getByText('Desk PC', { exact: true })).toBeVisible();
    const titles = [...container.querySelectorAll('li')].map(
      (row) => row.querySelector('div > span')?.textContent
    );
    expect(titles).toEqual(['Desk PCFull access', 'Phone', 'Laptop']);
    await expect.element(page.getByText('Maestro client', { exact: true })).toBeVisible();
  });
});
