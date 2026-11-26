import '@emdash/ui/style.css';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ClientSessionStatus } from '../api/client-session-contract';
import { ConnectionPill } from './connection-pill';
import { clientStatus } from './fake-client-session';

let container: HTMLDivElement;
let root: Root;
const handlers = { onCreateShortcut: vi.fn(), onQuit: vi.fn(), onForget: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(status: ClientSessionStatus, canCreateShortcut = true) {
  flushSync(() =>
    root.render(
      <ConnectionPill status={status} canCreateShortcut={canCreateShortcut} {...handlers} />
    )
  );
}

const pill = () => container.querySelector<HTMLElement>('[data-client-connection-pill]');
const item = (name: string) => page.getByRole('menuitem', { name, exact: true });

describe('ConnectionPill', () => {
  it('shows the host and the round trip, quietly', async () => {
    render(clientStatus());
    expect(pill()?.getAttribute('data-client-connection-pill')).toBe('steady');
    expect(pill()?.textContent).toBe('rig-vm24 ms');
    await expect
      .element(page.getByRole('button', { name: 'Host rig-vm: Connected, 24 ms. Connection menu' }))
      .toBeVisible();
  });

  it('turns the latency to the warning tone on a slow link', () => {
    render(clientStatus({ latencyMs: 640 }));
    expect(pill()?.getAttribute('data-client-connection-pill')).toBe('slow');
    const latency = [...(pill()?.querySelectorAll('span') ?? [])].find(
      (span) => span.textContent === '640 ms'
    );
    expect(latency?.className).toContain('text-foreground-warning');
  });

  it('drops the latency and marks the link while it reconnects or is refused', () => {
    render(clientStatus({ phase: 'reconnecting' }));
    expect(pill()?.getAttribute('data-client-connection-pill')).toBe('working');
    expect(pill()?.textContent).toBe('rig-vm');

    render(clientStatus({ phase: 'blocked', blocked: { reason: 'revoked' } }));
    expect(pill()?.getAttribute('data-client-connection-pill')).toBe('down');
  });

  it('opens a menu with the address and the link actions', async () => {
    render(clientStatus());
    await page.getByRole('button', { name: /Connection menu/u }).click();
    await expect.element(page.getByText('rig.tailnet.ts.net', { exact: true })).toBeVisible();

    await item('Create a shortcut').click();
    expect(handlers.onCreateShortcut).toHaveBeenCalledOnce();

    await page.getByRole('button', { name: /Connection menu/u }).click();
    await item('Disconnect and quit').click();
    expect(handlers.onQuit).toHaveBeenCalledOnce();

    await page.getByRole('button', { name: /Connection menu/u }).click();
    await item('Forget this host…').click();
    expect(handlers.onForget).toHaveBeenCalledOnce();
  });

  it('offers a shortcut only where the client can create one', async () => {
    render(clientStatus(), false);
    await page.getByRole('button', { name: /Connection menu/u }).click();
    await expect.element(item('Disconnect and quit')).toBeVisible();
    expect(page.getByRole('menuitem', { name: 'Create a shortcut' }).elements()).toHaveLength(0);
  });
});
