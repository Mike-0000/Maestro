import '@emdash/ui/style.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { clientStatus, createFakeClientSession } from './fake-client-session';
import { runClientGate } from './run-client-gate';

let splash: HTMLDivElement;

beforeEach(() => {
  splash = document.createElement('div');
  splash.id = 'boot-splash';
  document.body.appendChild(splash);
});

afterEach(() => {
  splash.remove();
  document.getElementById('client-gate-root')?.remove();
});

const gateRoot = () => document.getElementById('client-gate-root');

describe('runClientGate', () => {
  it('passes straight through when the link is already attached', async () => {
    const session = createFakeClientSession(clientStatus());
    await runClientGate({ session });
    expect(gateRoot()).toBeNull();
    expect(splash.style.display).toBe('');
  });

  it('stays behind the splash when a saved host answers quickly', async () => {
    const session = createFakeClientSession(clientStatus({ phase: 'connecting' }));
    const done = runClientGate({ session, graceMs: 60_000 });
    await Promise.resolve();
    session.setStatus(clientStatus());
    await done;
    expect(gateRoot()).toBeNull();
    expect(splash.style.display).toBe('');
  });

  it('waits for the first status before deciding', async () => {
    const session = createFakeClientSession();
    const settled = vi.fn();
    const done = runClientGate({ session }).then(settled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();
    expect(gateRoot()).toBeNull();

    session.setStatus(clientStatus());
    await done;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('shows pairing in place of the splash, then hands back to it once attached', async () => {
    const session = createFakeClientSession(
      clientStatus({ phase: 'unpaired', host: null, connectedAt: null })
    );
    const settled = vi.fn();
    const done = runClientGate({ session, windowChrome: <div data-window-chrome /> }).then(settled);

    await expect
      .element(page.getByRole('heading', { name: 'Connect to a Maestro host' }))
      .toBeVisible();
    expect(splash.style.display).toBe('none');
    expect(gateRoot()?.querySelector('[data-window-chrome]')).not.toBeNull();
    expect(settled).not.toHaveBeenCalled();

    session.setStatus(clientStatus({ phase: 'connecting' }));
    await expect.element(page.getByRole('status')).toHaveTextContent('Connecting to rig-vm…');
    expect(settled).not.toHaveBeenCalled();

    session.setStatus(clientStatus());
    await done;
    expect(gateRoot()).toBeNull();
    expect(splash.style.display).toBe('');
  });

  it('shows the gate when a saved host does not answer within the grace period', async () => {
    const session = createFakeClientSession(clientStatus({ phase: 'connecting' }));
    const done = runClientGate({ session, graceMs: 10 });
    await expect.element(page.getByRole('status')).toHaveTextContent('Connecting to rig-vm…');
    expect(splash.style.display).toBe('none');
    session.setStatus(clientStatus());
    await done;
    expect(gateRoot()).toBeNull();
  });

  it('shows why the host refused without waiting', async () => {
    const session = createFakeClientSession(
      clientStatus({ phase: 'blocked', blocked: { reason: 'busy' } })
    );
    const done = runClientGate({ session, graceMs: 60_000 });
    await expect
      .element(page.getByRole('heading', { name: 'rig-vm is in use by another client' }))
      .toBeVisible();
    session.setStatus(clientStatus());
    await done;
  });
});
