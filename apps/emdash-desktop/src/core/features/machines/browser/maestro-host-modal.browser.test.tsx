import { err, ok, type Result } from '@emdash/shared';
import '@emdash/ui/style.css';
import { Dialog } from '@emdash/ui/react/primitives';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { SshConfig } from '@core/primitives/ssh/api';
import type { MaestroHostError, MaestroHostInfo } from '../api/maestro-host';

type Saved = Result<SshConfig, MaestroHostError>;

const machine: SshConfig = {
  id: 'maestro-1',
  name: 'Studio',
  host: 'my-pc.tailnet.ts.net',
  port: 443,
  username: '',
  authType: 'agent',
  transport: 'maestro',
  maestro: { url: 'https://my-pc.tailnet.ts.net', hostId: 'host-1', cfAccessClientId: 'id.access' },
};

const store = vi.hoisted(() => ({
  inspectMaestroHost:
    vi.fn<(input: unknown) => Promise<Result<MaestroHostInfo, MaestroHostError>>>(),
  addMaestroHost: vi.fn<(input: unknown) => Promise<Saved>>(),
  repairMaestroHost: vi.fn<(input: unknown) => Promise<Saved>>(),
  updateMaestroHost: vi.fn<(input: unknown) => Promise<Saved>>(),
}));
const modal = vi.hoisted(() => ({ complete: vi.fn(), dismiss: vi.fn() }));

vi.mock('@core/features/machines/contributions/app-stores', () => ({
  getMachinesStore: () => store,
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useModalController: () => modal,
}));

import { MaestroHostModal, type MaestroHostModalProps } from './maestro-host-modal';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  store.addMaestroHost.mockResolvedValue(ok(machine));
  store.repairMaestroHost.mockResolvedValue(ok(machine));
  store.updateMaestroHost.mockResolvedValue(ok(machine));
  container = document.createElement('div');
  container.style.width = '440px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(props: MaestroHostModalProps = {}) {
  flushSync(() =>
    root.render(
      <Dialog.Root open>
        <Dialog.Content>
          <MaestroHostModal {...props} />
        </Dialog.Content>
      </Dialog.Root>
    )
  );
}

const field = (name: string) => page.getByRole('textbox', { name, exact: true });
const button = (name: string) => page.getByRole('button', { name, exact: true });

it('identifies the host before pairing and then adds it', async () => {
  store.inspectMaestroHost.mockResolvedValue(
    ok({
      url: 'https://my-pc.tailnet.ts.net',
      hostId: 'host-1',
      hostName: 'Studio',
      protocolVersion: '3.1',
    })
  );
  render();
  await expect.element(page.getByText('Add Maestro host', { exact: true })).toBeVisible();

  await field('Host address').fill('my-pc.tailnet.ts.net');
  await button('Check address').click();
  await expect.element(page.getByText('Found Maestro host “Studio”.')).toBeVisible();
  expect(store.inspectMaestroHost).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'my-pc.tailnet.ts.net', machineId: undefined })
  );

  await field('Pairing code').fill('123456');
  await button('Add host').click();

  await vi.waitFor(() =>
    expect(modal.complete).toHaveBeenCalledWith({ connectionId: 'maestro-1' })
  );
  expect(store.addMaestroHost).toHaveBeenCalledWith({
    url: 'my-pc.tailnet.ts.net',
    code: '123456',
    cfAccessClientId: '',
    cfAccessClientSecret: '',
  });
});

it('asks for what is missing without calling the host', async () => {
  render();
  await button('Add host').click();
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Enter the address of the Maestro host.');
  await field('Host address').fill('https://my-pc.tailnet.ts.net');
  await button('Add host').click();
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Enter the pairing code shown by the host.');
  expect(store.addMaestroHost).not.toHaveBeenCalled();
});

it("shows the host's refusal and stays open", async () => {
  store.addMaestroHost.mockResolvedValue(
    err({ type: 'invalid-code', message: 'The host did not accept that pairing code.' })
  );
  render();
  await field('Host address').fill('https://my-pc.tailnet.ts.net');
  await field('Pairing code').fill('000000');
  await button('Add host').click();

  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('The host did not accept that pairing code.');
  expect(modal.complete).not.toHaveBeenCalled();
});

it('sends Cloudflare Access credentials when they are entered', async () => {
  render();
  await field('Host address').fill('https://my-pc.tailnet.ts.net');
  await field('Pairing code').fill('123456');
  await page.getByText('Cloudflare Access', { exact: true }).click();
  await field('Client ID').fill('id.access');
  await page.getByLabelText('Client secret', { exact: true }).fill('cf-secret');
  await button('Add host').click();

  await vi.waitFor(() =>
    expect(store.addMaestroHost).toHaveBeenCalledWith({
      url: 'https://my-pc.tailnet.ts.net',
      code: '123456',
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: 'cf-secret',
    })
  );
});

it('pairs an existing machine again with only a new code', async () => {
  render({ mode: 'repair', machine });
  await expect.element(page.getByText('Pair again', { exact: true })).toBeVisible();
  await expect.element(field('Host address')).not.toBeInTheDocument();

  await field('Pairing code').fill('654321');
  await button('Pair').click();

  await vi.waitFor(() =>
    expect(modal.complete).toHaveBeenCalledWith({ connectionId: 'maestro-1' })
  );
  expect(store.repairMaestroHost).toHaveBeenCalledWith({ id: 'maestro-1', code: '654321' });
});

it('edits the address and keeps the saved Cloudflare secret when it is left blank', async () => {
  render({ mode: 'edit', machine });
  await expect.element(field('Host address')).toHaveValue('https://my-pc.tailnet.ts.net');
  await expect.element(field('Pairing code')).not.toBeInTheDocument();
  await expect.element(field('Client ID')).toHaveValue('id.access');
  await expect
    .element(page.getByLabelText('Client secret', { exact: true }))
    .toHaveAttribute('placeholder', 'Leave blank to keep the saved secret');

  await field('Host address').fill('http://127.0.0.1:7462');
  await button('Save').click();

  await vi.waitFor(() =>
    expect(store.updateMaestroHost).toHaveBeenCalledWith({
      id: 'maestro-1',
      url: 'http://127.0.0.1:7462',
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: '',
    })
  );
});
