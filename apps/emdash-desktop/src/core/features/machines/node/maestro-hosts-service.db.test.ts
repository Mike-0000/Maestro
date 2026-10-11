import type { Secret } from '@emdash/shared';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MachinesService,
  type MachineMutationEvent,
} from '@core/features/machines/api/node/machines-service';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { sshConnections } from '@core/services/app-db/node/schema';
import {
  maestroHostCredentialKeys,
  MaestroHostCredentialService,
} from '@core/services/hosts/node/maestro/maestro-host-credentials';
import { createMaestroHostDirectory } from '@core/services/hosts/node/maestro/maestro-host-directory';
import { createMaestroHostClient, type MaestroHostFetch } from './maestro-host-client';
import { MaestroHostsService } from './maestro-hosts-service';

type Reply = { status: number; body?: unknown };
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

const HOST_URL = 'https://my-pc.tailnet.ts.net';

/** A Maestro host's HTTP API: `/api/info` and `/api/pair`, with scripted replies. */
function fakeHost() {
  const calls: Call[] = [];
  const state = {
    info: {
      status: 200,
      body: { app: 'maestro', hostId: 'host-1', hostName: 'Studio', protocolVersion: '3.1' },
    } as Reply,
    pair: {
      status: 200,
      body: { deviceId: 'device-1', token: 'token-1', hostId: 'host-1', hostName: 'Studio' },
    } as Reply,
  };
  const fetch: MaestroHostFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const reply = url.endsWith('/api/pair') ? state.pair : state.info;
    return { status: reply.status, json: async () => reply.body };
  };
  return { calls, state, fetch };
}

describe('MaestroHostsService', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let host: ReturnType<typeof fakeHost>;
  let secrets: Map<string, Secret<string>>;
  let credentials: MaestroHostCredentialService;
  let mutations: MachineMutationEvent[];
  let service: MaestroHostsService;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    host = fakeHost();
    secrets = new Map();
    mutations = [];
    const store: SecretStore = {
      getSecret: async (key) => secrets.get(key) ?? null,
      setSecret: async (key, value) => void secrets.set(key, value),
      deleteSecret: async (key) => void secrets.delete(key),
    };
    credentials = new MaestroHostCredentialService(store);
    let nextId = 0;
    service = new MaestroHostsService({
      db: fixture.db,
      client: createMaestroHostClient({ fetch: host.fetch }),
      credentials,
      // Applied inside the service's transaction, like the encrypted store's prepared changes.
      prepareSecrets: (changes) => () => {
        for (const [key, value] of changes) {
          if (value) secrets.set(key, value);
          else secrets.delete(key);
        }
      },
      notifyMutated: (event) => mutations.push(event),
      deviceName: () => 'Laptop',
      createId: () => `maestro-${++nextId}`,
    });
  });

  afterEach(() => {
    fixture.close();
  });

  const storedToken = (id: string) => secrets.get(maestroHostCredentialKeys(id).deviceToken);
  const storedCfSecret = (id: string) =>
    secrets.get(maestroHostCredentialKeys(id).cfAccessClientSecret);
  const row = (id: string) =>
    fixture.db.select().from(sshConnections).where(eq(sshConnections.id, id)).get();

  async function addHost() {
    const added = await service.add({ url: `${HOST_URL}/`, code: ' 123456 ' });
    if (!added.success) throw new Error(added.error.message);
    host.calls.length = 0;
    mutations.length = 0;
    return added.data;
  }

  it('identifies a host without pairing or saving it', async () => {
    await expect(service.inspect({ url: 'my-pc.tailnet.ts.net/' })).resolves.toEqual({
      success: true,
      data: { url: HOST_URL, hostId: 'host-1', hostName: 'Studio', protocolVersion: '3.1' },
    });
    expect(host.calls).toEqual([
      { url: `${HOST_URL}/api/info`, method: 'GET', headers: { Accept: 'application/json' } },
    ]);
    expect(await fixture.db.select().from(sshConnections)).toEqual([]);
    expect(secrets.size).toBe(0);
  });

  it('rejects an address that is not a Maestro host before asking for anything else', async () => {
    host.state.info = { status: 404, body: { error: 'not found' } };
    await expect(service.add({ url: HOST_URL, code: '123456' })).resolves.toMatchObject({
      success: false,
      error: { type: 'not-maestro-host' },
    });
    expect(host.calls.map((call) => call.url)).toEqual([`${HOST_URL}/api/info`]);
    await expect(service.add({ url: 'ftp://example.com', code: '123456' })).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid-url' },
    });
  });

  it('pairs, stores the token as a secret, and saves the machine with v6 metadata', async () => {
    const added = await service.add({ url: `${HOST_URL}/`, code: ' 123456 ' });

    expect(added).toEqual({
      success: true,
      data: expect.objectContaining({
        id: 'maestro-1',
        name: 'Studio',
        host: 'my-pc.tailnet.ts.net',
        port: 443,
        transport: 'maestro',
        maestro: { url: HOST_URL, hostId: 'host-1' },
      }),
    });
    expect(host.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${HOST_URL}/api/info`,
      `POST ${HOST_URL}/api/pair`,
    ]);
    expect(host.calls[1]?.body).toEqual({ code: '123456', deviceName: 'Laptop', kind: 'desktop' });
    expect(row('maestro-1')?.metadata).toEqual({
      version: '7',
      transport: 'maestro',
      maestro: { url: HOST_URL, hostId: 'host-1' },
    });
    expect(storedToken('maestro-1')?.expose()).toBe('token-1');
    expect(storedCfSecret('maestro-1')).toBeUndefined();
    // Neither the row nor the value returned to the renderer carries the token.
    expect(JSON.stringify(row('maestro-1'))).not.toContain('token-1');
    expect(JSON.stringify(added)).not.toContain('token-1');
    expect(mutations).toEqual([{ type: 'saved', connectionId: 'maestro-1' }]);
  });

  it('sends Cloudflare Access credentials on every request and stores only the client ID in metadata', async () => {
    const added = await service.add({
      url: HOST_URL,
      code: '123456',
      cfAccessClientId: ' id.access ',
      cfAccessClientSecret: 'cf-secret',
    });

    expect(added.success).toBe(true);
    for (const call of host.calls) {
      expect(call.headers).toMatchObject({
        'CF-Access-Client-Id': 'id.access',
        'CF-Access-Client-Secret': 'cf-secret',
      });
    }
    expect(row('maestro-1')?.metadata?.maestro).toEqual({
      url: HOST_URL,
      hostId: 'host-1',
      cfAccessClientId: 'id.access',
    });
    expect(storedCfSecret('maestro-1')?.expose()).toBe('cf-secret');
    expect(JSON.stringify(row('maestro-1'))).not.toContain('cf-secret');
  });

  it('saves nothing when the host rejects the pairing code', async () => {
    host.state.pair = { status: 401, body: { error: 'invalid-code' } };
    await expect(service.add({ url: HOST_URL, code: '000000' })).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid-code' },
    });
    host.state.pair = { status: 429, body: { error: 'rate-limited' } };
    await expect(service.add({ url: HOST_URL, code: '000000' })).resolves.toMatchObject({
      success: false,
      error: { type: 'rate-limited' },
    });
    expect(await fixture.db.select().from(sshConnections)).toEqual([]);
    expect(secrets.size).toBe(0);
    expect(mutations).toEqual([]);
  });

  it('does not write the token when the machine row write fails', async () => {
    fixture.sqlite.exec(`CREATE TRIGGER fail_connection_write BEFORE INSERT ON ssh_connections
      BEGIN SELECT RAISE(ABORT, 'database write failed'); END`);
    await expect(service.add({ url: HOST_URL, code: '123456' })).rejects.toThrow(
      'database write failed'
    );
    expect(secrets.size).toBe(0);
    expect(mutations).toEqual([]);
  });

  it('refuses to add the same host twice and keeps machine names unique', async () => {
    await addHost();
    await expect(
      service.add({ url: 'https://other-address.example', code: '123456' })
    ).resolves.toMatchObject({ success: false, error: { type: 'already-added' } });
    expect(host.calls.some((call) => call.url.endsWith('/api/pair'))).toBe(false);

    host.state.info = {
      status: 200,
      body: { ...(host.state.info.body as object), hostId: 'host-2' },
    };
    host.state.pair = {
      status: 200,
      body: { ...(host.state.pair.body as object), hostId: 'host-2' },
    };
    await expect(
      service.add({ url: 'https://second.example', code: '123456' })
    ).resolves.toMatchObject({ success: true, data: { name: 'Studio 2' } });
  });

  it('pairs an existing machine again and replaces only its token', async () => {
    const added = await service.add({
      url: HOST_URL,
      code: '123456',
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: 'cf-secret',
    });
    if (!added.success) throw new Error(added.error.message);
    host.calls.length = 0;
    mutations.length = 0;
    host.state.pair = {
      status: 200,
      body: { deviceId: 'device-2', token: 'token-2', hostId: 'host-1', hostName: 'Studio' },
    };

    const repaired = await service.repair({ id: 'maestro-1', code: '654321' });

    expect(repaired).toMatchObject({ success: true, data: { id: 'maestro-1', name: 'Studio' } });
    // The saved Cloudflare credentials are reused for both requests.
    for (const call of host.calls) {
      expect(call.headers).toMatchObject({ 'CF-Access-Client-Secret': 'cf-secret' });
    }
    expect(storedToken('maestro-1')?.expose()).toBe('token-2');
    expect(storedCfSecret('maestro-1')?.expose()).toBe('cf-secret');
    expect(mutations).toEqual([{ type: 'saved', connectionId: 'maestro-1' }]);
  });

  it('refuses to pair a machine again with a different host', async () => {
    await addHost();
    host.state.info = {
      status: 200,
      body: { ...(host.state.info.body as object), hostId: 'other' },
    };

    await expect(service.repair({ id: 'maestro-1', code: '654321' })).resolves.toMatchObject({
      success: false,
      error: { type: 'host-mismatch' },
    });
    expect(host.calls.some((call) => call.url.endsWith('/api/pair'))).toBe(false);
    expect(storedToken('maestro-1')?.expose()).toBe('token-1');
  });

  it('changes the address and Cloudflare credentials while keeping the pairing', async () => {
    await addHost();

    const updated = await service.update({
      id: 'maestro-1',
      url: 'http://127.0.0.1:7462',
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: 'cf-secret',
    });

    expect(updated).toMatchObject({
      success: true,
      data: {
        host: '127.0.0.1',
        port: 7462,
        maestro: { url: 'http://127.0.0.1:7462', hostId: 'host-1', cfAccessClientId: 'id.access' },
      },
    });
    expect(host.calls).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:7462/api/info', method: 'GET' }),
    ]);
    expect(storedToken('maestro-1')?.expose()).toBe('token-1');
    expect(storedCfSecret('maestro-1')?.expose()).toBe('cf-secret');
    expect(mutations).toEqual([{ type: 'saved', connectionId: 'maestro-1' }]);

    // A blank secret keeps the saved one for the unchanged client ID…
    await expect(
      service.update({
        id: 'maestro-1',
        url: 'http://127.0.0.1:7462',
        cfAccessClientId: 'id.access',
        cfAccessClientSecret: '',
      })
    ).resolves.toMatchObject({ success: true });
    expect(host.calls.at(-1)?.headers).toMatchObject({ 'CF-Access-Client-Secret': 'cf-secret' });
    expect(storedCfSecret('maestro-1')?.expose()).toBe('cf-secret');

    // …but never carries it over to a different client ID…
    await expect(
      service.update({
        id: 'maestro-1',
        url: 'http://127.0.0.1:7462',
        cfAccessClientId: 'other.access',
        cfAccessClientSecret: '',
      })
    ).resolves.toMatchObject({ success: false, error: { type: 'cloudflare-access' } });
    expect(row('maestro-1')?.metadata?.maestro?.cfAccessClientId).toBe('id.access');

    // …and clearing the client ID removes the secret.
    await expect(
      service.update({
        id: 'maestro-1',
        url: 'http://127.0.0.1:7462',
        cfAccessClientId: '',
        cfAccessClientSecret: '',
      })
    ).resolves.toMatchObject({ success: true });
    expect(row('maestro-1')?.metadata?.maestro).toEqual({
      url: 'http://127.0.0.1:7462',
      hostId: 'host-1',
    });
    expect(storedCfSecret('maestro-1')).toBeUndefined();
  });

  it('does not move a machine to an address that is another host or unreachable', async () => {
    await addHost();
    host.state.info = {
      status: 200,
      body: { ...(host.state.info.body as object), hostId: 'other' },
    };
    await expect(
      service.update({ id: 'maestro-1', url: 'https://elsewhere.example' })
    ).resolves.toMatchObject({ success: false, error: { type: 'host-mismatch' } });
    host.state.info = { status: 502 };
    await expect(
      service.update({ id: 'maestro-1', url: 'https://elsewhere.example' })
    ).resolves.toMatchObject({ success: false, error: { type: 'not-maestro-host' } });
    expect(row('maestro-1')?.metadata?.maestro?.url).toBe(HOST_URL);
    expect(mutations).toEqual([]);
  });

  it('only pairs or edits machines that are Maestro hosts', async () => {
    await fixture.db.insert(sshConnections).values({
      id: 'ssh-1',
      name: 'Existing SSH',
      host: 'example.com',
      port: 22,
      username: 'jona',
      authType: 'agent',
      useAgent: 1,
    });
    await expect(service.repair({ id: 'ssh-1', code: '123456' })).resolves.toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    await expect(service.update({ id: 'missing', url: HOST_URL })).resolves.toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    expect(host.calls).toEqual([]);
  });

  it('gives the dial path the saved address and credentials, and tells Maestro hosts apart', async () => {
    await service.add({
      url: HOST_URL,
      code: '123456',
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: 'cf-secret',
    });
    await fixture.db.insert(sshConnections).values({
      id: 'ssh-1',
      name: 'Existing SSH',
      host: 'example.com',
      port: 22,
      username: 'jona',
      authType: 'agent',
      useAgent: 1,
    });
    const directory = createMaestroHostDirectory({ db: fixture.db, credentials });

    expect(directory.isMaestroHost('maestro-1')).toBe(true);
    expect(directory.isMaestroHost('ssh-1')).toBe(false);
    expect(directory.isMaestroHost('missing')).toBe(false);
    const config = await directory.resolve('maestro-1');
    expect(config.url).toBe(HOST_URL);
    expect(config.token?.expose()).toBe('token-1');
    expect(config.cfAccess?.clientId).toBe('id.access');
    expect(config.cfAccess?.clientSecret.expose()).toBe('cf-secret');

    secrets.delete(maestroHostCredentialKeys('maestro-1').deviceToken);
    await expect(directory.resolve('maestro-1')).resolves.toMatchObject({ token: null });
    await expect(directory.resolve('missing')).rejects.toThrow('no longer configured');
  });

  it('has no SSH settings to save, and deleting the machine removes its secrets', async () => {
    const added = await addHost();
    const deleteAllCredentials = vi.fn(async () => {});
    const machines = new MachinesService({
      db: fixture.db,
      credentials: { getPassword: vi.fn(), getPassphrase: vi.fn(), deleteAllCredentials },
      maestroCredentials: credentials,
      prepareCredentials: () => () => {},
      ssh: { dropConnection: vi.fn(async () => {}), removeRuntimeState: vi.fn() },
      log: { warn: vi.fn() },
    });

    expect((await machines.getMachines())[0]).toMatchObject({
      id: added.id,
      transport: 'maestro',
      maestro: { url: HOST_URL, hostId: 'host-1' },
    });
    await expect(
      machines.saveMachine({
        id: added.id,
        name: added.name,
        host: 'example.org',
        port: 22,
        username: 'jona',
        authType: 'agent',
      })
    ).rejects.toThrow('connects without SSH');
    expect(row(added.id)?.metadata?.transport).toBe('maestro');

    await machines.deleteMachine(added.id);
    expect(row(added.id)).toBeUndefined();
    expect(storedToken(added.id)).toBeUndefined();
  });
});
