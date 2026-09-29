import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { log } from '@core/primitives/logging/browser/logger';

/**
 * Most WebGL renderers kept at once. Chromium allows about 16 live WebGL contexts per renderer
 * and silently kills the oldest past that, so the pool stays under it with room for other
 * canvases on the page.
 */
export const MAX_WEBGL_TERMINALS = 12;

type Slot = { terminal: Terminal; addon: WebglAddon | null; failed: boolean };

/** Every terminal that wants WebGL, oldest request first; the newest `MAX` hold a context. */
const requests: Slot[] = [];

/**
 * Attach xterm's WebGL renderer. Used by canvas live tiles so many concurrent terminals paint on
 * the GPU. When more terminals ask than the pool allows, the most recent requests get WebGL and
 * the rest keep xterm's DOM renderer (same presentation) until a slot frees up. Returns a
 * disposer that falls back to DOM.
 */
export function attachWebglRenderer(terminal: Terminal): () => void {
  const slot: Slot = { terminal, addon: null, failed: false };
  requests.push(slot);
  rebalance();
  return () => {
    const index = requests.indexOf(slot);
    if (index !== -1) requests.splice(index, 1);
    release(slot);
    rebalance();
  };
}

function rebalance(): void {
  const live = requests.filter((slot) => !slot.failed);
  const keep = new Set(live.slice(-MAX_WEBGL_TERMINALS));
  for (const slot of live) if (!keep.has(slot)) release(slot);
  for (const slot of keep) if (!slot.addon) acquire(slot);
}

function acquire(slot: Slot): void {
  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    const current = addon;
    current.onContextLoss(() => {
      // The GPU dropped the context: stay on DOM for this terminal rather than thrash.
      if (slot.addon !== current) return;
      slot.failed = true;
      release(slot);
    });
    slot.terminal.loadAddon(addon);
    slot.addon = addon;
  } catch (error) {
    try {
      addon?.dispose();
    } catch {
      // Constructor or loadAddon failed before the addon was usable.
    }
    slot.failed = true;
    log.warn('FrontendPty: WebGL renderer unavailable', { error });
  }
}

function release(slot: Slot): void {
  const addon = slot.addon;
  slot.addon = null;
  try {
    addon?.dispose();
  } catch {
    // Context is already gone or the terminal was disposed.
  }
}
