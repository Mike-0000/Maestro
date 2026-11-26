import '@emdash/ui/style.css';
import { Tooltip } from '@emdash/ui/react/primitives';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { registerClientTitlebarStatus } from '@core/primitives/client-mode/browser/titlebar-status';
import {
  clientStatus,
  createFakeClientSession,
  type FakeClientSession,
} from '../../browser/fake-client-session';

const state = vi.hoisted(() => ({
  session: undefined as unknown,
  storeRequests: 0,
  clientRequests: 0,
  confirm: undefined as unknown,
}));

vi.mock('../../browser/client-session-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClientSessionStore: () => {
    state.storeRequests += 1;
    return state.session;
  },
}));
vi.mock('../../api/browser/client', () => ({
  getClientSessionClient: () => {
    state.clientRequests += 1;
    return new Promise(() => {});
  },
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => state.confirm,
}));
vi.mock('@core/features/workbench/contributions/browser/layout-provider', () => ({
  useWorkspaceLayoutContext: () => ({ isLeftOpen: true, toggleLeftSidebar: () => {} }),
}));
vi.mock('@core/features/workbench/browser/window-controls', () => ({
  WindowControls: () => null,
}));
vi.mock('@core/features/workbench/browser/sidebar-recovery-controls', () => ({
  SidebarRecoveryControls: () => null,
}));

import { BorderlessTitlebar } from '@core/features/workbench/contributions/browser/BorderlessTitlebar';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { ClientConnectionPill } from './client-connection-pill';

let container: HTMLDivElement;
let root: Root;
let session: FakeClientSession;
let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  session = createFakeClientSession(clientStatus());
  confirm = vi.fn(async () => ({ success: true }));
  state.session = session;
  state.confirm = confirm;
  state.storeRequests = 0;
  state.clientRequests = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  setClientModeForTesting(undefined);
  registerClientTitlebarStatus(null);
  flushSync(() => root.unmount());
  container.remove();
});

function render() {
  flushSync(() =>
    root.render(
      <Tooltip.Provider>
        <Titlebar rightSlot={<span data-right-slot />} />
        <div className="relative h-10">
          <BorderlessTitlebar />
        </div>
      </Tooltip.Provider>
    )
  );
}

const pills = () => container.querySelectorAll('[data-client-connection-pill]');

describe('title bars', () => {
  it('are unchanged in a local window: no pill and no client session', () => {
    setClientModeForTesting(false);
    render();
    expect(pills()).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);

    // Even a filled slot stays empty outside client mode.
    flushSync(() => registerClientTitlebarStatus(ClientConnectionPill));
    expect(pills()).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(state.storeRequests).toBe(0);
    expect(state.clientRequests).toBe(0);
  });

  it('show nothing in client mode until the bootstrap fills the slot', () => {
    setClientModeForTesting(true);
    render();
    expect(pills()).toHaveLength(0);
    flushSync(() => registerClientTitlebarStatus(ClientConnectionPill));
    expect(pills()).toHaveLength(2);
  });

  it('carry the link pill in client mode, after the view controls', () => {
    setClientModeForTesting(true);
    registerClientTitlebarStatus(ClientConnectionPill);
    render();
    expect(pills()).toHaveLength(2);
    const titlebarPill = pills()[0]!;
    const rightSlot = container.querySelector('[data-right-slot]')!;
    expect(
      rightSlot.compareDocumentPosition(titlebarPill) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(state.clientRequests).toBe(0);
  });

  it('show no pill before the link has reported or once the host is forgotten', () => {
    setClientModeForTesting(true);
    registerClientTitlebarStatus(ClientConnectionPill);
    state.session = createFakeClientSession();
    render();
    expect(pills()).toHaveLength(0);

    flushSync(() =>
      (state.session as FakeClientSession).setStatus(
        clientStatus({ phase: 'unpaired', host: null })
      )
    );
    expect(pills()).toHaveLength(0);
  });
});

describe('pill menu', () => {
  beforeEach(() => {
    setClientModeForTesting(true);
    registerClientTitlebarStatus(ClientConnectionPill);
    flushSync(() =>
      root.render(
        <Tooltip.Provider>
          <Titlebar />
        </Tooltip.Provider>
      )
    );
  });

  const open = () => page.getByRole('button', { name: /Connection menu/u }).click();
  const item = (name: string) => page.getByRole('menuitem', { name, exact: true });

  it('forgets the host only after the confirm dialog', async () => {
    confirm.mockResolvedValueOnce({ success: false });
    await open();
    await item('Forget this host…').click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Forget rig-vm?',
      variant: 'destructive',
    });
    expect(session.calls).toEqual([]);

    await open();
    await item('Forget this host…').click();
    await vi.waitFor(() => expect(session.calls).toEqual([{ action: 'forget' }]));
  });

  it('quits the client', async () => {
    await open();
    await item('Disconnect and quit').click();
    await vi.waitFor(() => expect(session.calls).toEqual([{ action: 'quit' }]));
  });
});
