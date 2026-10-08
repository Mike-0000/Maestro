import { secret } from '@emdash/shared';
import { WebSocketHandshakeError, type ConnectWebSocketOptions } from '@emdash/wire/node';
import type { WireTransport } from '@emdash/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import {
  MAESTRO_HOST_CLOUDFLARE_MESSAGE,
  MAESTRO_HOST_NOT_PAIRED_MESSAGE,
} from '@core/primitives/maestro-host/api/messages';
import {
  MaestroHostConnectionError,
  openMaestroWorkspaceServerTransport,
  type MaestroHostDialConfig,
} from './maestro-websocket-transport';

const target = { kind: 'maestro' as const, connectionId: 'maestro-1' };
const transport = { close: vi.fn() } as unknown as WireTransport;

function port(config: Partial<MaestroHostDialConfig>, dial = vi.fn(async () => transport)) {
  const resolve = vi.fn(
    async (): Promise<MaestroHostDialConfig> => ({
      url: 'https://my-pc.tailnet.ts.net',
      token: secret('device-token'),
      ...config,
    })
  );
  return { resolve, dial: dial as (options: ConnectWebSocketOptions) => Promise<WireTransport> };
}

async function failure(work: Promise<unknown>): Promise<MaestroHostConnectionError> {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason
  );
  if (!(error instanceof MaestroHostConnectionError)) throw new Error('Expected a dial failure');
  return error;
}

describe('openMaestroWorkspaceServerTransport', () => {
  it("dials the machine's Wire endpoint with its device token", async () => {
    const dial = vi.fn(async () => transport);
    const maestro = port({}, dial);
    const signal = new AbortController().signal;

    await expect(openMaestroWorkspaceServerTransport(target, maestro, { signal })).resolves.toBe(
      transport
    );

    expect(maestro.resolve).toHaveBeenCalledWith('maestro-1');
    expect(dial).toHaveBeenCalledWith({
      url: 'wss://my-pc.tailnet.ts.net/wire',
      headers: { Authorization: 'Bearer device-token' },
      signal,
      timeoutMs: undefined,
    });
  });

  it('adds the Cloudflare Access service token when the machine has one', async () => {
    const dial = vi.fn(async () => transport);
    await openMaestroWorkspaceServerTransport(
      target,
      port(
        {
          url: 'http://127.0.0.1:7462',
          cfAccess: { clientId: 'id.access', clientSecret: secret('cf-secret') },
        },
        dial
      )
    );

    expect(dial).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'ws://127.0.0.1:7462/wire',
        headers: {
          Authorization: 'Bearer device-token',
          'CF-Access-Client-Id': 'id.access',
          'CF-Access-Client-Secret': 'cf-secret',
        },
      })
    );
  });

  it('reads the address and credentials again for every dial', async () => {
    const maestro = port({});
    await openMaestroWorkspaceServerTransport(target, maestro);
    await openMaestroWorkspaceServerTransport(target, maestro);
    expect(maestro.resolve).toHaveBeenCalledTimes(2);
  });

  it('asks to pair again without dialing when the device token is gone', async () => {
    const dial = vi.fn(async () => transport);
    const error = await failure(
      openMaestroWorkspaceServerTransport(target, port({ token: null }, dial))
    );
    expect(error).toMatchObject({
      code: 'not-paired',
      kind: 'authentication',
      message: MAESTRO_HOST_NOT_PAIRED_MESSAGE,
    });
    expect(dial).not.toHaveBeenCalled();
  });

  it('maps a 401 handshake to a revoked pairing', async () => {
    const dial = vi.fn(async () => {
      throw new WebSocketHandshakeError('The host refused the connection (HTTP 401)', 401);
    });
    const error = await failure(openMaestroWorkspaceServerTransport(target, port({}, dial)));
    expect(error).toMatchObject({
      code: 'not-paired',
      kind: 'authentication',
      message: 'This device is no longer paired with the host. Pair again.',
    });
  });

  it('maps a 403 handshake to rejected Cloudflare Access credentials', async () => {
    const dial = vi.fn(async () => {
      throw new WebSocketHandshakeError('The host refused the connection (HTTP 403)', 403);
    });
    const error = await failure(openMaestroWorkspaceServerTransport(target, port({}, dial)));
    expect(error).toMatchObject({
      code: 'cloudflare-access',
      kind: 'authentication',
      message: MAESTRO_HOST_CLOUDFLARE_MESSAGE,
    });
  });

  it('reports any other dial failure as a retryable transport failure', async () => {
    for (const cause of [
      new WebSocketHandshakeError('The host refused the connection (HTTP 502)', 502),
      new WebSocketHandshakeError('Timed out connecting to the host'),
      new Error('connect ECONNREFUSED 127.0.0.1:7462'),
    ]) {
      const dial = vi.fn(async () => {
        throw cause;
      });
      const error = await failure(openMaestroWorkspaceServerTransport(target, port({}, dial)));
      expect(error).toMatchObject({ code: 'unreachable', kind: 'transport', cause });
      expect(error.message).toBe(`Could not reach the Maestro host: ${cause.message}`);
    }
  });

  it('passes a cancellation through unchanged', async () => {
    const controller = new AbortController();
    const reason = new Error('superseded');
    const dial = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      openMaestroWorkspaceServerTransport(target, port({}, dial), { signal: controller.signal })
    ).rejects.toBe(reason);
  });
});
