import type { WebContents } from 'electron';
import type { BrowserConsoleEntry } from '@core/primitives/browser/api';

const MAX_ENTRIES = 200;
const MAX_MESSAGE_CHARS = 500;

type ConsoleLevel = BrowserConsoleEntry['level'];

/**
 * Keeps the recent console output and failed loads of bound browsers so a model that looks at an
 * app also sees why it broke. Entries are page-controlled text: callers frame them as untrusted.
 */
export class BrowserConsoleBuffer {
  private readonly entriesByBrowserId = new Map<string, BrowserConsoleEntry[]>();
  private readonly detachByWebContentsId = new Map<number, () => void>();

  constructor(private readonly now: () => number = Date.now) {}

  attach(browserId: string, webContents: WebContents): void {
    this.detachWebContents(webContents.id);
    const onConsole = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      this.push(browserId, {
        level: normalizeLevel(details.level),
        message: details.message,
        source: details.sourceId ? `${details.sourceId}:${details.lineNumber}` : undefined,
      });
    };
    const onFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => {
      // -3 is ERR_ABORTED: a navigation replaced by another one, not a failure.
      if (errorCode === -3) return;
      this.push(browserId, {
        level: 'error',
        message: `Failed to load${isMainFrame ? '' : ' frame'} ${validatedURL}: ${errorDescription} (${errorCode})`,
      });
    };
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      this.push(browserId, { level: 'error', message: `Page process gone: ${details.reason}` });
    };
    webContents.on('console-message', onConsole);
    webContents.on('did-fail-load', onFailLoad);
    webContents.on('render-process-gone', onGone);
    this.detachByWebContentsId.set(webContents.id, () => {
      if (webContents.isDestroyed()) return;
      webContents.off('console-message', onConsole);
      webContents.off('did-fail-load', onFailLoad);
      webContents.off('render-process-gone', onGone);
    });
  }

  detachWebContents(webContentsId: number): void {
    this.detachByWebContentsId.get(webContentsId)?.();
    this.detachByWebContentsId.delete(webContentsId);
  }

  forget(browserId: string): void {
    this.entriesByBrowserId.delete(browserId);
  }

  push(browserId: string, entry: Omit<BrowserConsoleEntry, 'at'>): void {
    const entries = this.entriesByBrowserId.get(browserId) ?? [];
    entries.push({
      ...entry,
      at: this.now(),
      message:
        entry.message.length > MAX_MESSAGE_CHARS
          ? `${entry.message.slice(0, MAX_MESSAGE_CHARS)}…`
          : entry.message,
    });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    this.entriesByBrowserId.set(browserId, entries);
  }

  /** The newest entries at or above `minLevel`, oldest first. */
  tail(browserId: string, limit = 20, minLevel: ConsoleLevel = 'warning'): BrowserConsoleEntry[] {
    const floor = LEVEL_RANK[minLevel];
    const entries = (this.entriesByBrowserId.get(browserId) ?? []).filter(
      (entry) => LEVEL_RANK[entry.level] >= floor
    );
    return entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
  }
}

const LEVEL_RANK: Record<ConsoleLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

function normalizeLevel(level: unknown): ConsoleLevel {
  if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error') {
    return level;
  }
  // Older Electron builds report 0..3 (verbose, info, warning, error).
  if (level === 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 1) return 'info';
  return 'debug';
}
