import { ReplicaLog } from '@emdash/wire/live';
import { makeAutoObservable, runInAction } from 'mobx';
import type { TerminalGrid } from '../lib/terminal-fit';
import {
  encodePastedText,
  encodeTerminalKey,
  SUBMIT_DELAY_MS,
  SUBMIT_SEQUENCE,
  type TerminalKey,
} from '../lib/terminal-keys';
import { readTerminalTheme, TERMINAL_FONT_FAMILY } from '../lib/terminal-theme';
import { TerminalView, type TerminalZoom } from '../lib/terminal-view';
import type { RemoteApi } from '../lib/wire-link';

export type TerminalPhase = 'opening' | 'live' | 'failed';

type SessionOptions = {
  api: RemoteApi;
  conversationId: string;
  viewport: HTMLElement;
  onError(message: string): void;
};

/** Font size "Fit to this screen" sizes the grid for: readable on a phone, denser on a desktop. */
function comfortableFontSize(viewportWidth: number): number {
  return viewportWidth < 600 ? 12 : 13;
}

const ERROR_TOAST_INTERVAL_MS = 3_000;

/**
 * One open terminal agent: asks the host to make the session live, mirrors its output into an
 * xterm view, and carries input back. Lives exactly as long as the agent screen showing it.
 */
export class TerminalSession {
  phase: TerminalPhase = 'opening';
  error: string | null = null;
  /** The host terminal's grid, shared with the desktop window. */
  grid: TerminalGrid | null = null;
  zoom: TerminalZoom = 'fit';
  fontSize = 12;
  scrolledBack = false;
  resizing = false;

  private readonly view: TerminalView;
  private log: ReplicaLog | null = null;
  private disposed = false;
  private lastErrorAt = 0;

  constructor(private readonly options: SessionOptions) {
    this.view = new TerminalView(options.viewport, {
      fontFamily: TERMINAL_FONT_FAMILY,
      theme: readTerminalTheme(),
      onInput: (data) => this.send(data),
      onState: (state) =>
        runInAction(() => {
          this.zoom = state.zoom;
          this.fontSize = state.fontSize;
          this.scrolledBack = state.scrolledBack;
        }),
    });
    makeAutoObservable<TerminalSession, 'view' | 'log' | 'options' | 'disposed' | 'lastErrorAt'>(
      this,
      { view: false, log: false, options: false, disposed: false, lastErrorAt: false }
    );
    void this.open();
  }

  /** Starts or resumes the session on the host and (re)attaches to its output. */
  async open(): Promise<void> {
    const { api, conversationId, viewport } = this.options;
    runInAction(() => {
      this.phase = 'opening';
      this.error = null;
    });
    try {
      const size = this.view.gridForViewport(comfortableFontSize(viewport.clientWidth));
      const result = await api.remote.openAgent({ conversationId, size });
      if (this.disposed) return;
      if (!result.success) {
        this.fail(result.error.message);
        return;
      }
      const grid = result.data.size ?? size;
      this.view.setGrid(grid);
      runInAction(() => {
        this.grid = grid;
      });
      if (!this.log) {
        this.log = new ReplicaLog(api.remote.output.handle({ conversationId }), {
          store: this.view.createSink(),
        });
      }
      await this.log.ready;
      if (this.disposed) return;
      runInAction(() => {
        this.phase = 'live';
      });
    } catch (error) {
      if (this.disposed) return;
      void this.log?.dispose().catch(() => {});
      this.log = null;
      this.fail(error instanceof Error ? error.message : 'Could not open this agent');
    }
  }

  /**
   * Re-reads the host terminal's size. The desktop window can resize it at any time and nothing
   * announces that, so this runs whenever the screen comes back. Only for a running agent:
   * asking the host to open a stopped one would start it.
   */
  async syncGrid(): Promise<void> {
    if (this.disposed || this.phase !== 'live' || this.resizing) return;
    const { api, conversationId } = this.options;
    try {
      const result = await api.remote.openAgent({ conversationId });
      if (this.disposed || !result.success || !result.data.size) return;
      const grid = result.data.size;
      this.view.setGrid(grid);
      runInAction(() => {
        this.grid = grid;
      });
    } catch {
      // Offline; the next sync will catch up.
    }
  }

  /** Writes raw bytes to the agent's terminal. */
  send(data: string): void {
    if (this.disposed || !data) return;
    const { api, conversationId } = this.options;
    api.remote.sendInput({ conversationId, data }).then(
      (result) => {
        if (!result.success) this.reportError(result.error.message);
      },
      () => this.reportError('Could not reach the host. Your input was not sent.')
    );
  }

  sendKey(key: TerminalKey): void {
    this.send(encodeTerminalKey(key, this.view.modes));
  }

  /** Pastes `text` into the agent and presses Enter. Resolves false when nothing was sent. */
  async submitPrompt(text: string): Promise<boolean> {
    const payload = encodePastedText(text, this.view.modes);
    if (!payload || this.disposed) return false;
    const { api, conversationId } = this.options;
    try {
      const pasted = await api.remote.sendInput({ conversationId, data: payload });
      if (!pasted.success) {
        this.reportError(pasted.error.message);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
      const entered = await api.remote.sendInput({ conversationId, data: SUBMIT_SEQUENCE });
      if (!entered.success) this.reportError(entered.error.message);
      this.view.jumpToLatest();
      return true;
    } catch {
      this.reportError('Could not reach the host. Your message was not sent.');
      return false;
    }
  }

  /** Resizes the host terminal — for every viewer — to the grid that fills this screen. */
  async fitToScreen(): Promise<boolean> {
    if (this.disposed || this.resizing) return false;
    const { api, conversationId, viewport } = this.options;
    const grid = this.view.gridForViewport(comfortableFontSize(viewport.clientWidth));
    runInAction(() => {
      this.resizing = true;
    });
    try {
      const result = await api.remote.resize({ conversationId, ...grid });
      if (this.disposed) return false;
      if (!result.success) {
        this.reportError(result.error.message);
        return false;
      }
      this.view.setGrid(grid);
      this.view.setZoom('fit');
      runInAction(() => {
        this.grid = grid;
      });
      return true;
    } catch {
      this.reportError('Could not reach the host. The terminal was not resized.');
      return false;
    } finally {
      runInAction(() => {
        this.resizing = false;
      });
    }
  }

  setZoom(zoom: TerminalZoom): void {
    this.view.setZoom(zoom);
  }

  zoomBy(delta: number): void {
    this.view.zoomBy(delta);
  }

  jumpToLatest(): void {
    this.view.jumpToLatest();
  }

  focus(): void {
    this.view.focus();
  }

  refreshTheme(): void {
    this.view.setTheme(readTerminalTheme());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.log?.dispose().catch(() => {});
    this.log = null;
    this.view.dispose();
  }

  private fail(message: string): void {
    runInAction(() => {
      this.phase = 'failed';
      this.error = message;
    });
  }

  private reportError(message: string): void {
    const now = Date.now();
    if (now - this.lastErrorAt < ERROR_TOAST_INTERVAL_MS) return;
    this.lastErrorAt = now;
    this.options.onError(message);
  }
}
