import type { Terminal } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachWebglRenderer, MAX_WEBGL_TERMINALS } from './canvas-webgl';

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

  it('keeps WebGL on the newest terminals and hands a freed slot back', () => {
    const terminals = Array.from({ length: MAX_WEBGL_TERMINALS + 2 }, () => ({
      loadAddon: vi.fn(),
    }));
    const detach = terminals.map((terminal) =>
      attachWebglRenderer(terminal as unknown as Terminal)
    );
    const addonOf = (index: number) =>
      terminals[index]!.loadAddon.mock.calls[0]?.[0] as { dispose: ReturnType<typeof vi.fn> };

    // The two oldest were displaced to xterm's DOM renderer; the newest MAX hold contexts.
    expect(addonOf(0).dispose).toHaveBeenCalledTimes(1);
    expect(addonOf(1).dispose).toHaveBeenCalledTimes(1);
    for (let i = 2; i < terminals.length; i++) {
      expect(terminals[i]!.loadAddon).toHaveBeenCalledTimes(1);
      expect(addonOf(i).dispose).not.toHaveBeenCalled();
    }

    // Closing a WebGL terminal promotes the newest displaced one back onto the GPU.
    detach[terminals.length - 1]!();
    expect(terminals[1]!.loadAddon).toHaveBeenCalledTimes(2);
    expect(terminals[0]!.loadAddon).toHaveBeenCalledTimes(1);

    for (const release of detach) release();
  });

  it('leaves a terminal on DOM after its GPU context is lost', () => {
    const lossy = { loadAddon: vi.fn() };
    const detach = attachWebglRenderer(lossy as unknown as Terminal);
    const addon = lossy.loadAddon.mock.calls[0]?.[0] as {
      dispose: ReturnType<typeof vi.fn>;
      onContextLoss: ReturnType<typeof vi.fn>;
    };
    const loseContext = addon.onContextLoss.mock.calls[0]![0] as () => void;
    loseContext();
    expect(addon.dispose).toHaveBeenCalledTimes(1);

    // Another terminal churning the pool does not retry the lost one.
    attachWebglRenderer({ loadAddon: vi.fn() } as unknown as Terminal)();
    expect(lossy.loadAddon).toHaveBeenCalledTimes(1);
    detach();
  });
});
