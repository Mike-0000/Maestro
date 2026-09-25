import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { log } from '@core/primitives/logging/browser/logger';

/**
 * Attach xterm's WebGL renderer. Used by canvas live tiles so 4 concurrent
 * terminals paint on the GPU. Returns a disposer that falls back to DOM.
 */
export function attachWebglRenderer(terminal: Terminal): () => void {
  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    addon.onContextLoss(() => {
      try {
        addon?.dispose();
      } catch {
        // Context is already gone.
      }
      addon = null;
    });
    terminal.loadAddon(addon);
  } catch (error) {
    try {
      addon?.dispose();
    } catch {
      // Constructor or loadAddon failed before the addon was usable.
    }
    log.warn('FrontendPty: WebGL renderer unavailable', { error });
    return () => {};
  }

  return () => {
    try {
      addon?.dispose();
    } catch {
      // Terminal may already be disposed.
    }
    addon = null;
  };
}
