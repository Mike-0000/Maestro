import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@emdash/shared/logger';
import {
  client,
  connect,
  memoryTransportPair,
  serve,
  type Controller,
  type LiveUpdate,
} from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import type { TerminalFileSources } from '@core/services/attachments/node/prepare-terminal-files';
import { v8MessageTransport } from '@main/owner-link/v8-transport';
import {
  buildClientControllers,
  createClientTerminalsController,
  queuedOwnerClient,
  type ClientHandledDomain,
} from './client-controllers';
import { createHostLink, type HostLink } from './host-link';
import {
  createFakeOwnerHost,
  memoryPipePair,
  TEST_BUILD,
  type FakeOwnerHost,
} from './testing/fake-owner-host';

const HANDLED: ClientHandledDomain[] = [
  'appSettings',
  'browser',
  'conversations',
  'devPerf',
  'host',
  'logging',
  'terminals',
  'updates',
  'voice',
];

const logger = noopLogger;

const localFiles: TerminalFileSources = {
  async prepare(source) {
    return {
      kind: 'path',
      path: source.path,
      name: source.name ?? 'file.txt',
      mimeType: 'text/plain',
      snapshot: source.snapshot,
      dispose: async () => {},
    };
  },
};

function stub(name: string): Controller {
  return {
    call: async (path) => `${name}:${path}`,
    resolveLive: () => null,
    acquireLive: () => null,
  };
}

/** The desktop gateway's routing: the first path segment picks the domain controller. */
function router(controllers: Record<string, Controller>): Controller {
  const route = (path: string) => {
    const [domain, ...rest] = path.split('.');
    const controller = controllers[domain!];
    if (!controller) throw new Error(`Unknown path ${path}`);
    return { controller, path: rest.join('.') };
  };
  return {
    call: (path, input, meta) => {
      const routed = route(path);
      return routed.controller.call(routed.path, input, meta);
    },
    resolveLive: (topic) => {
      const routed = route(topic);
      return routed.controller.resolveLive(routed.path);
    },
    acquireLive: (topic) => {
      const routed = route(topic);
      return routed.controller.acquireLive(routed.path);
    },
  };
}

let host: FakeOwnerHost;
let link: HostLink;
let directory: string;

beforeEach(async () => {
  host = createFakeOwnerHost();
  link = createHostLink({
    build: TEST_BUILD,
    clientName: 'desk-pc',
    clientPlatform: 'win32',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pingIntervalMs: 0,
    backoffMs: [5],
    dial: async () => {
      const [clientPipe, serverPipe] = memoryPipePair();
      host.accept(v8MessageTransport(serverPipe));
      return clientPipe;
    },
  });
  directory = await mkdtemp(join(tmpdir(), 'client-controllers-'));
});

afterEach(async () => {
  link.close();
  await rm(directory, { recursive: true, force: true });
});

function renderer() {
  const owner = queuedOwnerClient(() => link.ready());
  const handled = Object.fromEntries(HANDLED.map((domain) => [domain, stub(domain)])) as Record<
    ClientHandledDomain,
    Controller
  >;
  handled.terminals = createClientTerminalsController(owner, { localFiles, logger });
  const controllers = buildClientControllers({ host: owner, handled });
  const pair = memoryTransportPair();
  serve(pair.right, router(controllers));
  return client(desktopWireContract, connect(pair.left));
}

describe('client controllers', () => {
  it('refuses a bundle with a domain the client must answer but does not', () => {
    const owner = queuedOwnerClient(() => link.ready());
    const handled = Object.fromEntries(
      HANDLED.filter((domain) => domain !== 'browser').map((domain) => [domain, stub(domain)])
    ) as Record<ClientHandledDomain, Controller>;
    expect(() => buildClientControllers({ host: owner, handled })).toThrow(/'browser'/);
  });

  it('answers local domains before the host is attached', async () => {
    const desktop = renderer();
    await expect(desktop.browser.getActiveBrowser(undefined)).resolves.toBe(
      'browser:getActiveBrowser'
    );
  });

  it('queues forwarded calls until the first attach, then forwards them', async () => {
    const desktop = renderer();
    const pending = desktop.mementos.deleteAll(undefined);
    link.start({
      url: 'http://127.0.0.1:7462',
      hostId: 'host-1',
      hostName: 'vm',
      deviceId: 'd',
      token: 't',
      pairedAt: 0,
    });
    await expect(pending).resolves.toEqual({ success: true, data: { deleted: 3 } });
  });

  it('forwards a live model and an event stream, across a reconnect', async () => {
    const desktop = renderer();
    link.start({
      url: 'http://127.0.0.1:7462',
      hostId: 'host-1',
      hostName: 'vm',
      deviceId: 'd',
      token: 't',
      pairedAt: 0,
    });
    const feed = desktop.notifications.feed.state(undefined, 'list');
    await expect(feed.snapshot()).resolves.toMatchObject({ data: {} });

    const updates: LiveUpdate[] = [];
    await feed.attach((update) => updates.push(update));
    host.notifications.set({ n1: notification('n1') });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    const events: string[] = [];
    await desktop.notifications.delivery.subscribe(undefined, {
      onEvent: (event) => {
        if (event.type === 'open') events.push(event.notificationId);
      },
    });
    host.emitDelivery('n1');
    await vi.waitFor(() => expect(events).toEqual(['n1']));

    await expect(feed.snapshot()).resolves.toMatchObject({ data: { n1: { title: 'n1' } } });
  });

  it('uploads client files and lets the host prepare its own paths (rule P)', async () => {
    const desktop = renderer();
    link.start({
      url: 'http://127.0.0.1:7462',
      hostId: 'host-1',
      hostName: 'vm',
      deviceId: 'd',
      token: 't',
      pairedAt: 0,
    });
    const clientFile = join(directory, 'screenshot.txt');
    await writeFile(clientFile, 'hello');
    const hostPath = '/home/dev/.drops/emdash-drop-1.png';

    const result = await desktop.terminals.attachments.prepareLocalFiles({
      workspaceId: 'ws-1',
      sources: [
        { path: clientFile, name: 'screenshot.txt', snapshot: false },
        { path: hostPath, snapshot: true },
      ],
    });

    expect(result).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          kind: 'attachment',
          name: 'screenshot.txt',
          targetPath: '/home/dev/.attachments/screenshot.txt',
        }),
        { kind: 'reference', targetPath: hostPath, pathStyle: 'posix' },
      ],
    });
    expect(host.uploads).toEqual([{ workspaceId: 'ws-1', name: 'screenshot.txt', bytes: 5 }]);
    expect(host.hostPreparedPaths).toEqual([hostPath]);
  });
});

function notification(id: string) {
  return {
    id,
    kind: 'test',
    groupKey: 'g',
    title: id,
    body: 'body',
    target: { kind: 'update' as const },
    source: { kind: 'app' as const },
    sound: null,
    count: 1,
    createdAt: 1,
    readAt: null,
  };
}
