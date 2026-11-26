import { homedir } from 'node:os';
import { app, BrowserWindow } from 'electron';
import { getMainWindow, showMainWindow } from '@main/host/window';
import type { HostWindowPort } from './host-window-suspension';

// The Electron side of the owner tier, kept out of the tier itself so it can be tested without
// Electron. Nothing here runs until an owner session attaches.

export const electronHostWindowPort: HostWindowPort = {
  current() {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return null;
    return { visible: window.isVisible() };
  },
  destroy() {
    const main = getMainWindow();
    // Task windows render the main window's page; close them first, then the main window.
    // `destroy` skips the main window's hide-on-close handler.
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== main && !window.isDestroyed()) window.destroy();
    }
    if (main && !main.isDestroyed()) main.destroy();
  },
  restore({ visible }) {
    const window = showMainWindow();
    if (!visible) window.hide();
  },
};

export function electronHostDetails(): {
  isPackaged: boolean;
  resourcesPath: string | undefined;
  platform: string;
  arch: string;
  homeDir: string;
} {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
  };
}
