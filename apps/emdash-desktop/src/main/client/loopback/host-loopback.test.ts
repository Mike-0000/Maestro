import { get as httpGet } from 'node:http';
import { noopLogger } from '@emdash/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerExternalOpenRequest } from '@core/features/client-mode/api/owner-contract';
import { startExternalOpenBridge } from '../adapters/external-open';
import type { OwnerHostClient } from '../host-link';
import {
  hostLoopbackUrlTarget,
  loopbackRedirectTarget,
  needsHostLoopback,
  openHostLoopbackRequest,
  openHostUrl,
} from './host-loopback';
import { createLoopbackMirrors, type LoopbackMirrorTarget } from './loopback-mirror';
import { startDevServer, startTunnelHost, TUNNEL_HOST_TOKEN } from './testing/tunnel-host';
import { createHostTunnelDialer, ownerTunnelConnector } from './tunnel-dialer';

/** Mirrors that hand out `remap(port)` as the local port, recording what was asked. */
function fakeMirrors(remap: (target: LoopbackMirrorTarget) => number = (target) => target.port) {
  const ensured: LoopbackMirrorTarget[] = [];
  return {
    ensured,
    ensure: vi.fn(async (target: LoopbackMirrorTarget) => {
      ensured.push(target);
      return remap(target);
    }),
  };
}

describe('hostLoopbackUrlTarget', () => {
  it.each([
    ['http://localhost:5173/app', { port: 5173, hostname: 'localhost' }],
    ['http://127.0.0.1:3000', { port: 3000, hostname: '127.0.0.1' }],
    ['http://[::1]:8080/', { port: 8080, hostname: '[::1]' }],
    ['http://app.localhost/', { port: 80, hostname: 'app.localhost' }],
    ['https://localhost/', { port: 443, hostname: 'localhost' }],
  ])('%s is on the host loopback', (url, target) => {
    expect(hostLoopbackUrlTarget(url)).toEqual(target);
  });

  it.each([
    'https://example.com/',
    'http://192.168.1.4:5173/',
    'file:///C:/index.html',
    'ws://localhost:5173/',
    'not a url',
  ])('%s is not', (url) => {
    expect(hostLoopbackUrlTarget(url)).toBeNull();
  });
});

describe('opening host pages on this computer', () => {
  it('opens any other URL unchanged, without a mirror', async () => {
    const mirrors = fakeMirrors();
    const open = vi.fn(async () => {});
    await openHostUrl('https://example.com/a?b=c', { mirrors, open });
    expect(open).toHaveBeenCalledWith('https://example.com/a?b=c');
    expect(mirrors.ensure).not.toHaveBeenCalled();
  });

  it('opens a host loopback URL through a mirror, on its port when free here', async () => {
    const mirrors = fakeMirrors();
    const open = vi.fn(async () => {});
    await openHostUrl('http://localhost:5173/app?x=1#top', { mirrors, open });
    expect(mirrors.ensured).toEqual([{ port: 5173, hostname: 'localhost', samePort: false }]);
    expect(open).toHaveBeenCalledWith('http://localhost:5173/app?x=1#top');
  });

  it('rewrites the port when the mirror had to use another one', async () => {
    const mirrors = fakeMirrors(() => 61_000);
    const open = vi.fn(async () => {});
    await openHostUrl('http://localhost:5173/app?x=1', { mirrors, open });
    expect(open).toHaveBeenCalledWith('http://localhost:61000/app?x=1');
  });

  it('mirrors the exact OAuth redirect port on 127.0.0.1 before opening the provider page', async () => {
    const order: string[] = [];
    const mirrors = fakeMirrors();
    mirrors.ensure.mockImplementation(async (target) => {
      order.push(`mirror ${target.port}`);
      return target.port;
    });
    const open = vi.fn(async (url: string) => {
      order.push(`open ${url}`);
    });
    await openHostLoopbackRequest(
      { url: 'https://auth.example.com/authorize?redirect_uri=x', loopbackPort: 49_152 },
      { mirrors, open }
    );
    expect(mirrors.ensure).toHaveBeenCalledWith({
      port: 49_152,
      hostname: '127.0.0.1',
      samePort: true,
    });
    expect(order).toEqual([
      'mirror 49152',
      'open https://auth.example.com/authorize?redirect_uri=x',
    ]);
  });

  it('does not open the provider page when the redirect port cannot be mirrored', async () => {
    const mirrors = fakeMirrors();
    mirrors.ensure.mockRejectedValue(new Error('Local port 49152 is in use on this computer'));
    const open = vi.fn(async () => {});
    await expect(
      openHostLoopbackRequest(
        { url: 'https://auth.example.com/authorize', loopbackPort: 49_152 },
        { mirrors, open }
      )
    ).rejects.toThrow('in use');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('sign-in pages that redirect to a host loopback callback', () => {
  const page =
    'https://claude.ai/oauth/authorize?client_id=x&redirect_uri=' +
    encodeURIComponent('http://localhost:54545/callback') +
    '&state=s';

  it('reads the callback port from redirect_uri', () => {
    expect(loopbackRedirectTarget(page)).toEqual({ port: 54_545, hostname: 'localhost' });
    expect(
      loopbackRedirectTarget(
        `https://a.example/x?redirect_url=${encodeURIComponent('http://127.0.0.1:8123/cb')}`
      )
    ).toEqual({ port: 8123, hostname: '127.0.0.1' });
    expect(needsHostLoopback(page)).toBe(true);
  });

  it.each([
    'https://github.com/login/device',
    `https://a.example/x?redirect_uri=${encodeURIComponent('https://app.example.com/cb')}`,
    `https://a.example/x?redirect_uri=${encodeURIComponent('http://localhost/cb')}`,
    `https://a.example/x?redirect_uri=${encodeURIComponent('http://192.168.1.5:8000/cb')}`,
    'https://a.example/x?redirect_uri=not-a-url',
  ])('%s has no host loopback callback', (url) => {
    expect(loopbackRedirectTarget(url)).toBeNull();
    expect(needsHostLoopback(url)).toBe(false);
  });

  it('mirrors the callback port on the same port before opening the page unchanged', async () => {
    const order: string[] = [];
    const mirrors = fakeMirrors();
    mirrors.ensure.mockImplementation(async (target) => {
      order.push(`mirror ${target.port} ${String(target.samePort)}`);
      return target.port;
    });
    const open = vi.fn(async (url: string) => {
      order.push(`open ${url}`);
    });
    await openHostUrl(page, { mirrors, open });
    expect(order).toEqual(['mirror 54545 true', `open ${page}`]);
  });

  it('still opens the page when the callback port is taken here', async () => {
    const mirrors = fakeMirrors();
    mirrors.ensure.mockRejectedValue(new Error('Local port 54545 is in use on this computer'));
    const open = vi.fn(async () => {});
    const warn = vi.fn();
    await openHostUrl(page, { mirrors, open, log: { warn } });
    expect(open).toHaveBeenCalledWith(page);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('host open requests through the external-open bridge', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  function fakeHost() {
    let emit: ((request: OwnerExternalOpenRequest) => void) | undefined;
    const host = {
      bridge: {
        externalOpenRequests: {
          subscribe: (
            _input: undefined,
            handlers: { onEvent(request: OwnerExternalOpenRequest): void }
          ) => {
            emit = handlers.onEvent;
            return () => {};
          },
        },
      },
    } as unknown as OwnerHostClient;
    return { host, emit: (request: OwnerExternalOpenRequest) => emit?.(request) };
  }

  it('mirrors the redirect port for an OAuth request and opens a host loopback page via a mirror', async () => {
    const mirrors = fakeMirrors((target) => (target.samePort ? target.port : 62_000));
    const opened: string[] = [];
    const open = async (url: string) => {
      opened.push(url);
    };
    const { host, emit } = fakeHost();
    const lifetime = new AbortController();
    cleanup.push(() => lifetime.abort());
    startExternalOpenBridge({
      host: async () => host,
      openExternal: (url) => openHostUrl(url, { mirrors, open }),
      openLoopback: (request) => openHostLoopbackRequest(request, { mirrors, open }),
      signal: lifetime.signal,
      log: noopLogger,
    });
    await vi.waitFor(() => expect(emit).toBeDefined());

    emit({ url: 'https://auth.example.com/start', loopbackPort: 50_000 });
    emit({ url: 'http://localhost:5173/' });
    emit({ url: 'https://example.com/docs' });
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    // Each request is handled as it arrives; the ones that need a mirror open after it is up.
    expect([...opened].sort()).toEqual([
      'http://localhost:62000/',
      'https://auth.example.com/start',
      'https://example.com/docs',
    ]);
    expect(mirrors.ensured).toEqual([
      { port: 50_000, hostname: '127.0.0.1', samePort: true },
      { port: 5173, hostname: 'localhost', samePort: false },
    ]);
  });

  it('serves the opened page from the host through a real tunnel', async () => {
    const host = await startTunnelHost();
    const dev = await startDevServer();
    const mirrors = createLoopbackMirrors({
      dialTunnel: createHostTunnelDialer({
        connect: ownerTunnelConnector({ url: host.url, token: TUNNEL_HOST_TOKEN }),
      }),
      log: noopLogger,
    });
    cleanup.push(
      () => host.close(),
      () => dev.close(),
      () => mirrors.close()
    );
    let opened = '';
    await openHostUrl(`http://localhost:${dev.port}/echo?page=1`, {
      mirrors,
      open: async (url) => {
        opened = url;
      },
    });
    const body = await new Promise<string>((resolve, reject) => {
      httpGet(opened.replace('localhost', '127.0.0.1'), { agent: false }, (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(JSON.parse(body).url).toBe('/echo?page=1');
    expect(host.tunnelCount()).toBe(1);
  });
});
