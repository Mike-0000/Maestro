import { webContents } from 'electron';
import {
  browserProfilePartition,
  DEFAULT_BROWSER_PROFILE_ID,
  isBrowserDataClearKind,
  isBrowsingDataKind,
  type BrowserAction,
  type BrowserDataClearKind,
  type BrowserImage,
  type BrowserObserveInput,
} from '@core/primitives/browser/api';
import { getAppSettingsService } from '@main/bootstrap/core/service-instances';
import {
  browserAutomation,
  browserControlService,
} from '@main/host/browser/browser-control-instance';
import { configureBrowserProfileSession } from '@main/host/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/host/browser/browser-webcontents-registry';
import { isBrowserPartition } from '@main/host/browser/webview-security';

export const browserOperations = {
  registerSession: (args: { browserId: string; partition: string }) => {
    if (!args.browserId.trim() || !isBrowserPartition(args.partition)) {
      return { success: false as const, error: 'Invalid browser session' };
    }
    configureBrowserProfileSession(args.partition);
    browserWebContentsRegistry.registerSession(args);
    return { success: true as const };
  },

  unregisterSession: (browserId: string) => {
    const webContents = browserWebContentsRegistry.getBoundWebContents(browserId);
    if (webContents) browserAutomation.release(webContents);
    browserWebContentsRegistry.unregisterSession(browserId);
    return { success: true as const };
  },

  bindWebContents: (args: { browserId: string; webContentsId: number }) => {
    const target = webContents.fromId(args.webContentsId);
    if (!target || target.isDestroyed()) {
      return { success: false as const };
    }
    return { success: browserWebContentsRegistry.bindWebContents(args.browserId, target) };
  },

  setActiveBrowser: (browserId: string | null) => {
    browserWebContentsRegistry.setActiveBrowser(browserId);
    return { success: true as const };
  },

  getActiveBrowser: () => ({ browserId: browserWebContentsRegistry.getActiveBrowser() }),

  openDevTools: (browserId: string) => ({
    success: import.meta.env.DEV && browserWebContentsRegistry.openDevTools(browserId),
  }),

  captureScreenshot: async (browserId: string) => ({
    success: await browserWebContentsRegistry.captureScreenshotToClipboard(browserId),
  }),

  clearData: async (browserId: string, kind: BrowserDataClearKind) => {
    if (!isBrowserDataClearKind(kind)) {
      return { success: false as const, error: 'Invalid browser data clear kind' };
    }
    return { success: await browserWebContentsRegistry.clearData(browserId, kind) };
  },

  clearProfileStorage: async (profileId: string) => ({
    success: await browserWebContentsRegistry.clearProfileStorage(profileId),
  }),

  clearBrowsingData: async (kind: string) => {
    if (!isBrowsingDataKind(kind)) {
      return { success: false as const, error: 'Invalid browsing data kind' };
    }
    const partitions = await collectBrowserPartitions();
    return { success: await browserWebContentsRegistry.clearBrowsingData(kind, partitions) };
  },

  // Renderer-initiated automation is the conductor: it runs in the renderer's store.
  observe: (input: BrowserObserveInput) =>
    browserControlService.observe({ kind: 'conductor' }, input),

  act: (input: { browserId: string; action: BrowserAction }) =>
    browserControlService.act({ kind: 'conductor' }, input),

  consoleTail: (input: { browserId: string; limit: number }) =>
    browserControlService.consoleTail({ kind: 'conductor' }, input.browserId, input.limit),

  setControl: (input: Parameters<typeof browserControlService.setControl>[0]) =>
    browserControlService.setControl(input),

  stopLease: (browserId: string) => {
    browserControlService.stopLease(browserId);
    return { success: true as const };
  },

  forgetControl: (browserId: string) => {
    browserControlService.forget(browserId);
    return { success: true as const };
  },

  ackOpenRequest: (input: { requestId: string; browserId: string | null }) => {
    browserControlService.ackOpenRequest(input.requestId, input.browserId);
    return { success: true as const };
  },

  capturePreview: (input: { browserId: string; maxEdge: number }) =>
    capturePreview(input.browserId, input.maxEdge),
};

async function capturePreview(browserId: string, maxEdge: number): Promise<BrowserImage | null> {
  const target = browserWebContentsRegistry.getBoundWebContents(browserId);
  return target ? browserAutomation.preview(target, maxEdge) : null;
}

// Every persistent profile partition (default + named) plus any partitions with
// live sessions, so clearing browsing data covers isolated-per-task tabs too.
async function collectBrowserPartitions(): Promise<string[]> {
  const browserSettings = await getAppSettingsService().get('browser');
  const partitions = new Set<string>([browserProfilePartition(DEFAULT_BROWSER_PROFILE_ID)]);
  for (const profile of browserSettings.profiles) {
    partitions.add(browserProfilePartition(profile.id));
  }
  for (const partition of browserWebContentsRegistry.registeredPartitions) {
    partitions.add(partition);
  }
  return [...partitions];
}
