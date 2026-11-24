import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import devIcon from '@/assets/images/chorus/chorus-dev.png?asset';
import { TASK_WINDOW_FRAME_PREFIX } from '@core/features/tasks/api/task-window';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { log } from '@main/lib/logger';

/**
 * A request to open a popped-out task window, as `setWindowOpenHandler` sees it. The renderer
 * fills that window itself (it portals the task view into the blank page), so the page is only
 * ever `about:blank`.
 */
export function isTaskWindowRequest(details: { url: string; frameName: string }): boolean {
  return details.frameName.startsWith(TASK_WINDOW_FRAME_PREFIX) && details.url === 'about:blank';
}

export function taskWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 400,
    title: PRODUCT_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121a1e' : '#fafcfd',
    autoHideMenuBar: true,
    ...(import.meta.env.DEV && { icon: devIcon }),
  };
}

let openTaskWindows = 0;

/**
 * Sets up a popped-out task window once Electron created it. It runs in the main window's
 * renderer, so that page keeps animating and running timers while the main window is hidden or
 * minimized and only a task window is on screen; throttling resumes when the last one closes.
 */
export function adoptTaskWindow(
  main: BrowserWindow,
  child: BrowserWindow,
  harden: (child: BrowserWindow) => void
): void {
  if (process.platform !== 'darwin') child.setMenuBarVisibility(false);
  harden(child);
  openTaskWindows += 1;
  if (!main.isDestroyed()) main.webContents.setBackgroundThrottling(false);
  child.once('closed', () => {
    openTaskWindows = Math.max(0, openTaskWindows - 1);
    if (openTaskWindows === 0 && !main.isDestroyed()) {
      main.webContents.setBackgroundThrottling(true);
    }
  });
  log.info('task window opened', { open: openTaskWindows });
}
