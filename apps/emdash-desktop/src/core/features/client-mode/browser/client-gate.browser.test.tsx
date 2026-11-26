import { err } from '@emdash/shared';
import '@emdash/ui/style.css';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ClientSessionStatus } from '../api/client-session-contract';
import { HOST_UPDATE_RECHECK_MS } from './blocked-panel';
import { ClientGate } from './client-gate';
import type { ClientUpdatesPort } from './client-update';
import {
  clientStatus,
  createFakeClientSession,
  type FakeClientSession,
} from './fake-client-session';

vi.mock('@core/primitives/desktop-host/browser/host-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  copyTextToClipboard: vi.fn(async () => {}),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  flushSync(() => root.unmount());
  container.remove();
});

function render(session: FakeClientSession, getUpdatesClient?: () => Promise<ClientUpdatesPort>) {
  flushSync(() =>
    root.render(<ClientGate session={session} getUpdatesClient={getUpdatesClient} />)
  );
}

function blocked(
  reason: NonNullable<ClientSessionStatus['blocked']>['reason'],
  extra: Partial<NonNullable<ClientSessionStatus['blocked']>> = {}
): ClientSessionStatus {
  return clientStatus({
    phase: 'blocked',
    blocked: { reason, ...extra },
    connectedAt: null,
    latencyMs: null,
  });
}

const actions = (session: FakeClientSession) => session.calls.map((call) => call.action);
const field = (name: string) => page.getByRole('textbox', { name, exact: true });
const button = (name: string) => page.getByRole('button', { name, exact: true });
const heading = (name: string) => page.getByRole('heading', { name, exact: true });

describe('pairing', () => {
  const unpaired = clientStatus({ phase: 'unpaired', host: null, connectedAt: null });

  it('pairs with the address and code, then says it is connecting', async () => {
    const session = createFakeClientSession(unpaired);
    render(session);
    await expect.element(heading('Connect to a Maestro host')).toBeVisible();

    await field('Host address').fill('  https://rig.tailnet.ts.net ');
    await field('Pairing code').fill('abcd-efgh');
    await button('Connect').click();

    await expect.element(page.getByText('Paired. Connecting…')).toBeVisible();
    expect(session.calls).toEqual([
      {
        action: 'pair',
        input: {
          url: 'https://rig.tailnet.ts.net',
          code: 'abcd-efgh',
          cfAccessClientId: undefined,
          cfAccessClientSecret: undefined,
        },
      },
    ]);
  });

  it('asks for what is missing without calling the host', async () => {
    const session = createFakeClientSession(unpaired);
    render(session);
    await button('Connect').click();
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Enter the address of the Maestro host.');
    await field('Host address').fill('rig.tailnet.ts.net');
    await button('Connect').click();
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Enter the pairing code shown by the host.');
    expect(session.calls).toEqual([]);
  });

  it("shows the host's refusal with the next thing to try, and lets the person try again", async () => {
    const session = createFakeClientSession(unpaired);
    session.results.pair = err({ type: 'unreachable', message: 'Could not reach rig.' });
    render(session);
    await field('Host address').fill('rig');
    await field('Pairing code').fill('ABCD');
    await button('Connect').click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Could not reach rig.');
    await expect.element(page.getByText(/Check the address/u)).toBeVisible();
    await expect.element(button('Connect')).toBeEnabled();

    await field('Host address').fill('rig.tailnet.ts.net');
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });

  it('sends Cloudflare Access credentials when they are entered', async () => {
    const session = createFakeClientSession(unpaired);
    render(session);
    await field('Host address').fill('https://rig.example.com');
    await field('Pairing code').fill('ABCD');
    await button('Cloudflare Access').click();
    await field('Client ID').fill('id.access');
    await page.getByLabelText('Client secret').fill('secret');
    await button('Connect').click();

    await vi.waitFor(() => expect(session.calls).toHaveLength(1));
    expect(session.calls[0]?.input).toMatchObject({
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: 'secret',
    });
  });

  it('offers the command for a host without a screen', async () => {
    render(createFakeClientSession(unpaired));
    await button('The host has no screen?').click();
    await expect.element(page.getByText(/api\/owner\/pairing-code/u)).toBeVisible();
  });
});

describe('connecting', () => {
  it('names the host and its address', async () => {
    const session = createFakeClientSession(clientStatus({ phase: 'connecting' }));
    render(session);
    await expect.element(page.getByRole('status')).toHaveTextContent('Connecting to rig-vm…');
    await expect.element(page.getByText('rig.tailnet.ts.net', { exact: true })).toBeVisible();
  });

  it('says how the retries are going and can retry at once', async () => {
    const session = createFakeClientSession(
      clientStatus({ phase: 'reconnecting', attempt: 3, lastError: 'connect ETIMEDOUT' })
    );
    render(session);
    await expect.element(page.getByRole('status')).toHaveTextContent('Reconnecting to rig-vm…');
    await expect.element(page.getByText('Attempt 3')).toBeVisible();
    await expect.element(page.getByText('connect ETIMEDOUT')).toBeVisible();

    await button('Retry now').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['retryNow']));
  });

  it('shows why an action failed', async () => {
    const session = createFakeClientSession(clientStatus({ phase: 'connecting' }));
    session.rejectWith = new Error('The client is shutting down.');
    render(session);
    await button('Retry now').click();
    await expect.element(page.getByRole('alert')).toHaveTextContent('The client is shutting down.');
  });

  it('follows the link from one screen to the next', async () => {
    const session = createFakeClientSession(clientStatus({ phase: 'connecting' }));
    render(session);
    await expect.element(page.getByRole('status')).toHaveTextContent('Connecting to rig-vm…');
    flushSync(() => session.setStatus(blocked('owner-disabled')));
    await expect.element(heading('Full access is turned off on rig-vm')).toBeVisible();
  });
});

describe('build mismatch', () => {
  const mismatch = blocked('build-mismatch', {
    clientBuild: { version: '1.4.2', commit: '3f9c2abcdef', dev: false },
    hostBuild: { version: '1.4.3', commit: 'a1b2c3d4e5f', dev: false },
  });

  function updates(): ClientUpdatesPort & { quitAndInstall: ReturnType<typeof vi.fn> } {
    const snapshot = { currentVersion: '1.4.2', availableVersion: '1.4.3' };
    return {
      check: vi.fn(async () => ({ success: true, result: null })),
      getState: vi.fn(async () => ({ success: true, data: { status: 'available', ...snapshot } })),
      download: vi.fn(async () => ({
        success: true,
        data: { status: 'downloaded', ...snapshot },
      })),
      quitAndInstall: vi.fn(async () => ({ success: true })),
      events: { subscribe: vi.fn(async () => () => {}) },
    } as unknown as ClientUpdatesPort & { quitAndInstall: ReturnType<typeof vi.fn> };
  }

  it('names both builds and marks the one that is behind', async () => {
    render(createFakeClientSession(mismatch));
    await expect.element(heading('This client and rig-vm run different builds')).toBeVisible();
    await expect.element(page.getByText('1.4.2 (3f9c2ab) · behind')).toBeVisible();
    await expect.element(page.getByText('1.4.3 (a1b2c3d)', { exact: true })).toBeVisible();
    await expect.element(button('Update this client')).toBeVisible();
    await expect.element(button('Update host')).toBeVisible();
  });

  it('updates this client and restarts into the new build', async () => {
    const client = updates();
    render(createFakeClientSession(mismatch), async () => client);
    await button('Update this client').click();

    await expect
      .element(page.getByText('1.4.3 is ready. Restart this client to finish.'))
      .toBeVisible();
    await button('Restart to update').click();
    await vi.waitFor(() => expect(client.quitAndInstall).toHaveBeenCalledOnce());
  });

  it('says so when this client has nothing newer to install', async () => {
    const client = updates();
    client.getState = vi.fn(async () => ({
      success: true,
      data: { status: 'idle', currentVersion: '1.4.2' },
    })) as unknown as ClientUpdatesPort['getState'];
    render(createFakeClientSession(mismatch), async () => client);
    await button('Update this client').click();
    await expect
      .element(
        page.getByText('This client is already on its newest build. Update the host instead.')
      )
      .toBeVisible();
  });

  it('asks the host to update when idle, then keeps looking for it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const session = createFakeClientSession(mismatch);
    render(session);
    await button('Update host').click();

    await expect
      .element(page.getByText(/rig-vm will update as soon as none of its agents are working/u))
      .toBeVisible();
    expect(session.calls).toEqual([{ action: 'requestHostUpdate', input: 'idle' }]);

    vi.advanceTimersByTime(HOST_UPDATE_RECHECK_MS);
    await vi.waitFor(() => expect(actions(session)).toContain('retryNow'));

    await button('Update now, stopping its agents').click();
    await expect.element(page.getByText(/rig-vm is updating now/u)).toBeVisible();
    expect(session.calls).toContainEqual({ action: 'requestHostUpdate', input: 'now' });
  });

  it('explains a host that cannot update itself', async () => {
    const session = createFakeClientSession(mismatch);
    session.results.requestHostUpdate = err({
      type: 'unsupported',
      message: 'This host does not update itself.',
    });
    render(session);
    await button('Update host').click();
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('This host does not update itself.');
    await expect.element(page.getByText(/Update Maestro on the host by hand/u)).toBeVisible();
  });
});

describe('other refusals', () => {
  it('pairs again in place after the pairing was removed', async () => {
    const session = createFakeClientSession(blocked('revoked'));
    render(session);
    await expect.element(heading('This client was removed from rig-vm')).toBeVisible();
    await expect.element(field('Host address')).toHaveValue('https://rig.tailnet.ts.net');

    await field('Pairing code').fill('WXYZ');
    await button('Pair again').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['pair']));
    expect(session.calls[0]?.input).toMatchObject({
      url: 'https://rig.tailnet.ts.net',
      code: 'WXYZ',
    });
  });

  it('takes over a host that another client is using', async () => {
    const session = createFakeClientSession(blocked('busy', { busyClientName: 'Laptop' }));
    render(session);
    await expect.element(heading('rig-vm is in use by another client')).toBeVisible();
    await expect.element(page.getByText(/Laptop is connected\./u)).toBeVisible();
    await button('Take over').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['takeOver']));
  });

  it('reconnects here after another client took over', async () => {
    const session = createFakeClientSession(blocked('superseded'));
    render(session);
    await expect.element(heading('Another client took over rig-vm')).toBeVisible();
    await button('Reconnect here').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['takeOver']));
  });

  it('tries again once full access is back on, with the host detail shown', async () => {
    const session = createFakeClientSession(
      blocked('owner-disabled', { detail: 'ownerAccess.enabled is false' })
    );
    render(session);
    await expect.element(heading('Full access is turned off on rig-vm')).toBeVisible();
    await expect.element(page.getByText('ownerAccess.enabled is false')).toBeVisible();
    await button('Try again').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['retryNow']));
  });

  it('explains a host that only accepts Tailscale', async () => {
    render(createFakeClientSession(blocked('tailscale-required')));
    await expect.element(heading('rig-vm only accepts clients over Tailscale')).toBeVisible();
    await expect.element(button('Try again')).toBeVisible();
  });

  it('forgets the host only after a second, explicit step', async () => {
    const session = createFakeClientSession(blocked('owner-disabled'));
    render(session);
    await button('Forget this host').click();
    await expect
      .element(page.getByText(/Forget rig-vm\? Pairing again needs a new code/u))
      .toBeVisible();
    expect(session.calls).toEqual([]);

    await button('Keep').click();
    await expect.element(button('Forget this host')).toBeVisible();
    await button('Forget this host').click();
    await button('Forget').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['forget']));
  });

  it('can always quit', async () => {
    const session = createFakeClientSession(blocked('tailscale-required'));
    render(session);
    await button('Disconnect and quit').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['quit']));
  });
});

describe('a client that cannot read its own state', () => {
  it('says so and offers a restart', async () => {
    const session = createFakeClientSession();
    session.failToLoad(new Error('clientSession is not served'));
    render(session);
    await expect.element(page.getByText('This client could not start')).toBeVisible();
    await button('Restart the client').click();
    await vi.waitFor(() => expect(actions(session)).toEqual(['relaunch']));
  });
});
