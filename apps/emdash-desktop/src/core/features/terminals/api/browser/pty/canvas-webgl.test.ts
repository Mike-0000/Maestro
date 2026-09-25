import type { Terminal } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachWebglRenderer } from './canvas-webgl';

const { WebglAddon, loadAddon } = vi.hoisted(() => {
  const loadAddon = vi.fn();
  class WebglAddon {
    dispose = vi.fn();
    onContextLoss = vi.fn();
  }
  return { WebglAddon, loadAddon };
});

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon }));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('attachWebglRenderer', () => {
  beforeEach(() => {
    loadAddon.mockReset();
  });

  it('loads the WebGL addon and disposes it on release', () => {
    const terminal = { loadAddon } as unknown as Terminal;
    const detach = attachWebglRenderer(terminal);
    expect(loadAddon).toHaveBeenCalledTimes(1);
    const addon = loadAddon.mock.calls[0]?.[0] as { dispose: ReturnType<typeof vi.fn> };
    detach();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to a no-op disposer when WebGL cannot start', () => {
    loadAddon.mockImplementation(() => {
      throw new Error('no webgl');
    });
    const terminal = { loadAddon } as unknown as Terminal;
    const detach = attachWebglRenderer(terminal);
    expect(() => detach()).not.toThrow();
  });
});
