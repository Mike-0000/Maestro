import { secret } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { createMaestroHostClient, type MaestroHostFetch } from './maestro-host-client';

type Reply = { status: number; body?: unknown };

function fakeFetch(reply: Reply | Error) {
  return vi.fn<MaestroHostFetch>(async () => {
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status,
      json: async () => {
        if (reply.body === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return reply.body;
      },
    };
  });
}

const info = { app: 'maestro', hostId: 'host-1', hostName: 'Studio', protocolVersion: '3.1' };
const pairing = {
  deviceId: 'device-1',
  token: 'device-token',
  hostId: 'host-1',
  hostName: 'Studio',
};
const cfAccess = { clientId: 'id.access', clientSecret: secret('cf-secret') };

describe('Maestro host client: info', () => {
  it('asks the host who it is, without credentials', async () => {
    const fetch = fakeFetch({ status: 200, body: info });
    const result = await createMaestroHostClient({ fetch }).info('http://127.0.0.1:7462');

    expect(result).toEqual({
      success: true,
      data: { hostId: 'host-1', hostName: 'Studio', protocolVersion: '3.1' },
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7462/api/info',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      })
    );
  });

  it('sends the Cloudflare Access service token on every request', async () => {
    const fetch = fakeFetch({ status: 200, body: info });
    await createMaestroHostClient({ fetch }).info('https://example.com', cfAccess);
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({
      'CF-Access-Client-Id': 'id.access',
      'CF-Access-Client-Secret': 'cf-secret',
      Accept: 'application/json',
    });
  });

  it('rejects an address that does not answer as a Maestro host', async () => {
    for (const reply of [
      { status: 404, body: { error: 'not found' } },
      { status: 200, body: { app: 'something-else', hostId: 'x', hostName: 'x' } },
      { status: 200 },
    ]) {
      const result = await createMaestroHostClient({ fetch: fakeFetch(reply) }).info(
        'https://example.com'
      );
      expect(result).toMatchObject({ success: false, error: { type: 'not-maestro-host' } });
    }
  });

  it('recognises a gateway turning the request away', async () => {
    for (const status of [302, 403]) {
      const result = await createMaestroHostClient({ fetch: fakeFetch({ status }) }).info(
        'https://example.com'
      );
      expect(result).toMatchObject({ success: false, error: { type: 'cloudflare-access' } });
    }
  });

  it('reports an unreachable host with the underlying reason', async () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:7462'),
    });
    const result = await createMaestroHostClient({ fetch: fakeFetch(error) }).info(
      'http://127.0.0.1:7462'
    );
    expect(result).toEqual({
      success: false,
      error: {
        type: 'unreachable',
        message: 'Could not reach the host: connect ECONNREFUSED 127.0.0.1:7462',
      },
    });
  });

  it('reports a host that never answers as unreachable', async () => {
    const fetch = vi.fn<MaestroHostFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const result = await createMaestroHostClient({ fetch, timeoutMs: 5 }).info(
      'https://example.com'
    );
    expect(result).toMatchObject({
      success: false,
      error: { type: 'unreachable', message: expect.stringContaining('did not answer in time') },
    });
  });
});

describe('Maestro host client: pair', () => {
  const request = { code: '123456', deviceName: 'Laptop' };

  it('trades the code for a device token that stays wrapped', async () => {
    const fetch = fakeFetch({ status: 200, body: pairing });
    const result = await createMaestroHostClient({ fetch }).pair(
      'https://example.com',
      request,
      cfAccess
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/pair',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: '123456', deviceName: 'Laptop', kind: 'desktop' }),
        headers: {
          'CF-Access-Client-Id': 'id.access',
          'CF-Access-Client-Secret': 'cf-secret',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      })
    );
    if (!result.success) throw new Error(result.error.message);
    expect(result.data).toMatchObject({
      deviceId: 'device-1',
      hostId: 'host-1',
      hostName: 'Studio',
    });
    expect(result.data.token.expose()).toBe('device-token');
    expect(JSON.stringify(result.data)).not.toContain('device-token');
  });

  it('maps the host refusals to actionable errors', async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 401, body: { error: 'invalid-code' } }, 'invalid-code'],
      [{ status: 429, body: { error: 'rate-limited' } }, 'rate-limited'],
      [{ status: 403 }, 'cloudflare-access'],
      [{ status: 500, body: { error: 'boom' } }, 'failed'],
      [{ status: 200, body: { deviceId: 'device-1' } }, 'failed'],
    ];
    for (const [reply, type] of cases) {
      const result = await createMaestroHostClient({ fetch: fakeFetch(reply) }).pair(
        'https://example.com',
        request
      );
      expect(result).toMatchObject({ success: false, error: { type } });
    }
  });
});
