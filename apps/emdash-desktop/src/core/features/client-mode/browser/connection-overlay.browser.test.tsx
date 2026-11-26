import '@emdash/ui/style.css';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ConnectionOverlay } from './connection-overlay';
import {
  clientStatus,
  createFakeClientSession,
  type FakeClientSession,
} from './fake-client-session';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(session: FakeClientSession, graceMs = 40) {
  flushSync(() =>
    root.render(
      <>
        <ConnectionOverlay session={session} graceMs={graceMs} />
        <button type="button">App control</button>
      </>
    )
  );
}

const overlay = () => container.querySelector('[data-connection-overlay]');
const mode = () => overlay()?.getAttribute('data-connection-overlay') ?? null;
const button = (name: string) => page.getByRole('button', { name, exact: true });
const dialog = () => page.getByRole('alertdialog');
const actions = (session: FakeClientSession) => session.calls.map((call) => call.action);

describe('ConnectionOverlay', () => {
  it('renders nothing while the link is up or not yet known', () => {
    render(createFakeClientSession(clientStatus()));
    expect(overlay()).toBeNull();
    flushSync(() => root.unmount());
    root = createRoot(container);
    render(createFakeClientSession());
    expect(overlay()).toBeNull();
  });

  it('starts a drop as a quiet banner that leaves the app usable', async () => {
    const session = createFakeClientSession(clientStatus());
    render(session, 60_000);
    flushSync(() => session.setStatus(clientStatus({ phase: 'reconnecting', attempt: 1 })));

    expect(mode()).toBe('banner');
    await expect.element(page.getByRole('status')).toHaveTextContent('Reconnecting to rig-vm…');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(overlay()?.className).toContain('pointer-events-none');

    flushSync(() => session.setStatus(clientStatus()));
    expect(overlay()).toBeNull();
  });

  it('blocks the window once the drop outlasts the grace period', async () => {
    const session = createFakeClientSession(clientStatus());
    render(session);
    flushSync(() =>
      session.setStatus(
        clientStatus({ phase: 'reconnecting', attempt: 4, lastError: 'socket hang up' })
      )
    );

    await expect.element(dialog()).toBeVisible();
    expect(mode()).toBe('blocking');
    await expect.element(dialog()).toHaveAccessibleName('Reconnecting to rig-vm…');
    await expect.element(page.getByText('Attempt 4')).toBeVisible();
    await expect.element(page.getByText('socket hang up')).toBeVisible();

    await button('Retry now').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['retryNow']));
    await button('Disconnect and quit').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['retryNow', 'quit']));

    flushSync(() => session.setStatus(clientStatus()));
    expect(overlay()).toBeNull();
  });

  it('blocks at once when the host refuses the link', async () => {
    const session = createFakeClientSession(clientStatus());
    render(session, 60_000);
    flushSync(() =>
      session.setStatus(
        clientStatus({
          phase: 'blocked',
          blocked: { reason: 'superseded', busyClientName: 'Laptop' },
        })
      )
    );

    expect(mode()).toBe('blocking');
    await expect.element(dialog()).toHaveAccessibleName('Another client took over rig-vm');
    await expect
      .element(page.getByText(/Laptop connected, so this window was disconnected/u))
      .toBeVisible();
    await button('Reconnect here').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['takeOver']));
  });

  it('offers a restart when the host was forgotten under a running app', async () => {
    const session = createFakeClientSession(clientStatus({ phase: 'unpaired', host: null }));
    render(session);
    await expect.element(dialog()).toHaveAccessibleName('This client is no longer paired');
    await button('Restart the client').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['relaunch']));
  });

  it('takes the keyboard while it blocks and gives focus back afterwards', async () => {
    const session = createFakeClientSession(clientStatus());
    render(session, 0);
    const appControl = page.getByRole('button', { name: 'App control' }).element() as HTMLElement;
    appControl.focus();
    // Stands in for the app's shortcut dispatcher, which attaches after the overlay mounts.
    const appShortcut = vi.fn();
    window.addEventListener('keydown', appShortcut, true);

    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
      expect(appShortcut).toHaveBeenCalledTimes(1);

      flushSync(() => session.setStatus(clientStatus({ phase: 'reconnecting' })));
      await expect.element(dialog()).toBeVisible();
      const card = dialog().element();
      expect(card.contains(document.activeElement)).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
      expect(appShortcut).toHaveBeenCalledTimes(1);

      // Tab from the last control wraps to the first instead of reaching the app behind.
      const controls = [...card.querySelectorAll<HTMLElement>('button')];
      controls[controls.length - 1]!.focus();
      controls[controls.length - 1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      );
      expect(document.activeElement).toBe(controls[0]);

      flushSync(() => session.setStatus(clientStatus()));
      expect(overlay()).toBeNull();
      expect(document.activeElement).toBe(appControl);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
      expect(appShortcut).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('keydown', appShortcut, true);
    }
  });
});
