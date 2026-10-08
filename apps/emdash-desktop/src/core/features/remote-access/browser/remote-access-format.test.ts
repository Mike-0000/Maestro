import { describe, expect, it } from 'vitest';
import type { RemoteAccessDevice } from '@core/features/remote-access/api';
import {
  deviceActivity,
  deviceKindLabel,
  formatCountdown,
  formatListenerAddress,
  listenerStateLine,
  parsePortInput,
  requestsEndpoint,
  sortDevices,
  tailscaleStage,
} from './remote-access-format';

const listener = {
  enabled: true,
  listening: true,
  port: 7462,
  bindAddress: '127.0.0.1',
  error: null,
};

function device(overrides: Partial<RemoteAccessDevice> & { id: string }): RemoteAccessDevice {
  return {
    name: overrides.id,
    kind: 'browser',
    createdAt: 0,
    lastSeenAt: null,
    connections: 0,
    ...overrides,
  };
}

describe('listenerStateLine', () => {
  it('holds a neutral placeholder until the first snapshot', () => {
    expect(listenerStateLine(undefined)).toEqual({ tone: 'neutral', text: 'Checking…' });
  });

  it('reads Off when disabled, even with a stale error', () => {
    expect(listenerStateLine({ ...listener, enabled: false, listening: false })).toEqual({
      tone: 'neutral',
      text: 'Off',
    });
    expect(
      listenerStateLine({ ...listener, enabled: false, listening: false, error: 'port in use' })
        .text
    ).toBe('Off');
  });

  it('names the address while listening', () => {
    expect(listenerStateLine(listener)).toEqual({
      tone: 'success',
      text: 'Listening on 127.0.0.1:7462',
    });
  });

  it('surfaces the error when enabled but not listening', () => {
    expect(
      listenerStateLine({ ...listener, listening: false, error: 'Port 7462 is already in use.' })
    ).toEqual({ tone: 'error', text: 'Port 7462 is already in use.' });
  });

  it('reads Starting while enabled with neither a listener nor an error', () => {
    expect(listenerStateLine({ ...listener, listening: false })).toEqual({
      tone: 'neutral',
      text: 'Starting…',
    });
  });
});

describe('formatListenerAddress', () => {
  it('brackets IPv6 hosts', () => {
    expect(formatListenerAddress('::1', 7462)).toBe('[::1]:7462');
    expect(formatListenerAddress('127.0.0.1', 7462)).toBe('127.0.0.1:7462');
  });
});

describe('formatCountdown', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatCountdown(600_000, 0)).toBe('10:00');
    expect(formatCountdown(600_000, 535_000)).toBe('1:05');
    expect(formatCountdown(600_000, 591_000)).toBe('0:09');
  });

  it('rounds partial seconds up so the last second is still shown', () => {
    expect(formatCountdown(1_000, 1)).toBe('0:01');
  });

  it('never goes below zero', () => {
    expect(formatCountdown(1_000, 1_000)).toBe('0:00');
    expect(formatCountdown(1_000, 99_000)).toBe('0:00');
  });
});

describe('device helpers', () => {
  it('labels device kinds', () => {
    expect(deviceKindLabel('browser')).toBe('Phone or browser');
    expect(deviceKindLabel('desktop')).toBe('Maestro app');
  });

  it('prefers a live connection over the last-seen time', () => {
    expect(deviceActivity({ connections: 2, lastSeenAt: 5 })).toEqual({ kind: 'connected' });
    expect(deviceActivity({ connections: 0, lastSeenAt: 5 })).toEqual({
      kind: 'last-seen',
      at: 5,
    });
    expect(deviceActivity({ connections: 0, lastSeenAt: null })).toEqual({ kind: 'never' });
  });

  it('sorts connected first, then recently seen, then recently paired', () => {
    const sorted = sortDevices([
      device({ id: 'never-old', createdAt: 1 }),
      device({ id: 'seen-old', lastSeenAt: 10 }),
      device({ id: 'never-new', createdAt: 2 }),
      device({ id: 'connected', connections: 1, lastSeenAt: 1 }),
      device({ id: 'seen-new', lastSeenAt: 20 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      'connected',
      'seen-new',
      'seen-old',
      'never-new',
      'never-old',
    ]);
  });
});

describe('parsePortInput', () => {
  it('accepts ports in range, ignoring surrounding whitespace', () => {
    expect(parsePortInput(' 7462 ')).toEqual({ ok: true, port: 7462 });
    expect(parsePortInput('1024')).toEqual({ ok: true, port: 1024 });
    expect(parsePortInput('65535')).toEqual({ ok: true, port: 65535 });
  });

  it('rejects out-of-range and non-numeric input', () => {
    for (const text of ['', '80', '1023', '65536', '74.62', '7462a', '-7462', '1e4']) {
      expect(parsePortInput(text).ok, text).toBe(false);
    }
  });
});

describe('tailscaleStage', () => {
  const base = { available: true, running: true, serving: false, url: null };

  it('walks from missing to serving', () => {
    expect(tailscaleStage({ ...base, available: false, running: false })).toBe('missing');
    expect(tailscaleStage({ ...base, running: false })).toBe('signed-out');
    expect(tailscaleStage(base)).toBe('ready');
    expect(tailscaleStage({ ...base, serving: true, url: 'https://pc.tail1234.ts.net' })).toBe(
      'serving'
    );
  });

  it('treats serving without an address as not yet serving', () => {
    expect(tailscaleStage({ ...base, serving: true })).toBe('ready');
  });
});

describe('requestsEndpoint', () => {
  const serving = {
    available: true,
    running: true,
    serving: true,
    url: 'https://pc.tail1234.ts.net/',
  };

  it('uses the Tailscale address once serving, without doubling the slash', () => {
    expect(requestsEndpoint(listener, serving)).toBe('https://pc.tail1234.ts.net/v1/requests');
  });

  it('falls back to the local listener', () => {
    expect(requestsEndpoint(listener, undefined)).toBe('http://127.0.0.1:7462/v1/requests');
    expect(requestsEndpoint(listener, { ...serving, serving: false })).toBe(
      'http://127.0.0.1:7462/v1/requests'
    );
  });
});
