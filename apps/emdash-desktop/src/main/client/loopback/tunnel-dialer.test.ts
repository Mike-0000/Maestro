import { WebSocketHandshakeError } from '@emdash/wire/node';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerTunnelTarget } from '@main/owner-link/endpoints';
import type { TunnelPipe } from '@main/owner-link/tunnel-protocol';
import { createHostTunnelDialer, hostLoopbackFamilies } from './tunnel-dialer';

function stubPipe(): TunnelPipe {
  return {
    closed: false,
    send: () => true,
    onMessage: () => () => {},
    onClose: () => () => {},
    onDrain: () => () => {},
    pause: () => {},
    resume: () => {},
    close: () => {},
    end: () => {},
  };
}

const refused = (status: number) => new WebSocketHandshakeError(`HTTP ${status}`, status);

describe('hostLoopbackFamilies', () => {
  it.each([
    ['localhost', [4, 6]],
    ['LOCALHOST', [4, 6]],
    ['localhost.', [4, 6]],
    ['app.localhost', [4, 6]],
    ['127.0.0.1', [4]],
    ['127.1.2.3', [4]],
    ['[::1]', [6]],
    ['::1', [6]],
  ])('%s is loopback', (hostname, families) => {
    expect(hostLoopbackFamilies(hostname)).toEqual(families);
  });

  it.each([
    'example.com',
    'localhost.example.com',
    'mylocalhost',
    '10.0.0.1',
    '0.0.0.0',
    '192.168.1.5',
    '[::]',
    '[fe80::1]',
    '[::ffff:7f00:1]',
    '',
  ])('%j is not', (hostname) => {
    expect(hostLoopbackFamilies(hostname)).toBeNull();
  });
});

describe('createHostTunnelDialer', () => {
  it('refuses a name that is not loopback without dialing', async () => {
    const connect = vi.fn();
    const dial = createHostTunnelDialer({ connect });
    await expect(dial(80, 'example.com')).rejects.toThrow('Not a loopback address');
    expect(connect).not.toHaveBeenCalled();
  });

  it('tries IPv6 for localhost when IPv4 is unreachable, and remembers the answer', async () => {
    const tried: OwnerTunnelTarget[] = [];
    const connect = vi.fn(async (target: OwnerTunnelTarget) => {
      tried.push(target);
      if (target.family === 4) throw refused(502);
      return stubPipe();
    });
    const dial = createHostTunnelDialer({ connect });
    await dial(5173, 'localhost');
    expect(tried).toEqual([
      { port: 5173, family: 4 },
      { port: 5173, family: 6 },
    ]);
    tried.length = 0;
    await dial(5173, 'localhost');
    expect(tried).toEqual([{ port: 5173, family: 6 }]);
  });

  it('dials only the family an address literal names', async () => {
    const connect = vi.fn(async (_target: OwnerTunnelTarget): Promise<TunnelPipe> => {
      throw refused(502);
    });
    const dial = createHostTunnelDialer({ connect });
    await expect(dial(80, '127.0.0.1')).rejects.toBeInstanceOf(WebSocketHandshakeError);
    expect(connect.mock.calls.map(([target]) => target.family)).toEqual([4]);
    connect.mockClear();
    await expect(dial(80, '[::1]')).rejects.toBeInstanceOf(WebSocketHandshakeError);
    expect(connect.mock.calls.map(([target]) => target.family)).toEqual([6]);
  });

  it('does not retry a refusal other than "unreachable"', async () => {
    const connect = vi.fn(async (_target: OwnerTunnelTarget): Promise<TunnelPipe> => {
      throw refused(409);
    });
    const dial = createHostTunnelDialer({ connect });
    await expect(dial(5173, 'localhost')).rejects.toMatchObject({ statusCode: 409 });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('waits for the owner session before dialing, but not forever', async () => {
    let attach!: () => void;
    const attached = new Promise<void>((resolve) => {
      attach = resolve;
    });
    const connect = vi.fn(async () => stubPipe());
    const dial = createHostTunnelDialer({ connect, ready: () => attached });
    const pending = dial(5173, 'localhost');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connect).not.toHaveBeenCalled();
    attach();
    await pending;
    expect(connect).toHaveBeenCalledTimes(1);

    const never = createHostTunnelDialer({
      connect,
      ready: () => new Promise(() => {}),
      readyTimeoutMs: 10,
    });
    await never(5173, 'localhost');
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
