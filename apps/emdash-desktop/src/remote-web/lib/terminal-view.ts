import type { LogSink } from '@emdash/wire/live';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import {
  clampFontSize,
  fitFontSize,
  gridForArea,
  pinchFontSize,
  type TerminalGrid,
} from './terminal-fit';
import type { TerminalInputModes } from './terminal-keys';

/** `fit` scales the font so the host's columns span the screen; a number is a chosen size. */
export type TerminalZoom = 'fit' | number;

export type TerminalViewState = {
  fontSize: number;
  zoom: TerminalZoom;
  /** The user has scrolled away from the live end of the output. */
  scrolledBack: boolean;
};

export type TerminalViewOptions = {
  fontFamily: string;
  theme: ITheme;
  onInput(data: string): void;
  onState(state: TerminalViewState): void;
};

const PADDING_PX = 8;
const SCROLLBACK_LINES = 5_000;
const INITIAL_FONT_SIZE = 12;
const TRUNCATED_NOTICE = '\r\n[earlier output truncated]\r\n';
/** Momentum: velocity kept per 16 ms frame, and the speed (px/ms) below which it stops. */
const FRICTION = 0.94;
const MIN_VELOCITY = 0.03;

/**
 * An xterm terminal that mirrors a host terminal of a fixed grid inside a viewport of any size.
 *
 * The host's grid is shared with the desktop window, so it is never changed to suit this screen.
 * Instead the font is scaled until the columns fit the width (or to a size the user picks, with
 * horizontal scrolling), and when the rows are taller than the viewport — the on-screen keyboard
 * is up — the terminal is anchored to its bottom edge, where the prompt is.
 */
export class TerminalView {
  readonly terminal: Terminal;
  private readonly stage: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly cleanups: (() => void)[] = [];
  private zoom: TerminalZoom = 'fit';
  /** Pixels of the terminal hidden above the viewport's top edge. */
  private offsetY = 0;
  private stickToBottom = true;
  private scrollRemainder = 0;
  private momentumFrame = 0;
  private inputEnabled = false;
  private disposed = false;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly options: TerminalViewOptions
  ) {
    this.stage = document.createElement('div');
    this.stage.className = 'terminal-stage';
    viewport.appendChild(this.stage);

    this.terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: SCROLLBACK_LINES,
      // convertEol stays off: the host PTY owns line discipline (see the desktop's FrontendPty).
      fontFamily: options.fontFamily,
      fontSize: INITIAL_FONT_SIZE,
      lineHeight: 1,
      letterSpacing: 0,
      allowProposedApi: true,
      scrollOnUserInput: false,
      cursorBlink: false,
      theme: options.theme,
    });
    this.terminal.loadAddon(new WebLinksAddon());
    // xterm's DOM renderer, as in the desktop app: it follows any font size exactly, which the
    // fit-to-width scaling depends on.
    this.terminal.open(this.stage);

    const element = this.terminal.element;
    if (element) element.style.padding = `${PADDING_PX}px`;

    // Touch screens type through the composer; keep taps on the terminal from raising the
    // on-screen keyboard while leaving a hardware keyboard fully working.
    if (window.matchMedia('(pointer: coarse)').matches) {
      this.terminal.textarea?.setAttribute('inputmode', 'none');
    }
    this.terminal.textarea?.setAttribute('aria-label', 'Terminal input');

    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    const input = this.terminal.onData((data) => {
      if (this.inputEnabled) options.onInput(data);
    });
    const scroll = this.terminal.onScroll(() => this.emitState());
    this.cleanups.push(
      () => input.dispose(),
      () => scroll.dispose()
    );

    this.attachGestures();
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(viewport);
    this.layout();
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /**
   * The sink the host's output log is replicated into. Appends are coalesced to one write per
   * frame so a redraw storm from a TUI does not schedule a write per chunk.
   */
  createSink(): LogSink {
    let pending = '';
    let epoch = 0;
    let scheduled = false;
    return {
      reset: (data) => {
        epoch += 1;
        pending = '';
        scheduled = false;
        // Replaying history makes xterm answer the queries in it; those answers are stale and
        // must not reach the program, so input is held until the replay has been parsed.
        this.inputEnabled = false;
        this.terminal.reset();
        if (data.truncated) this.terminal.write(TRUNCATED_NOTICE);
        const replayed = (): void => {
          if (this.disposed) return;
          this.inputEnabled = true;
          this.stickToBottom = true;
          this.terminal.scrollToBottom();
          this.layout();
        };
        if (data.text) this.terminal.write(data.text, replayed);
        else replayed();
      },
      append: (chunk) => {
        if (!chunk) return;
        pending += chunk;
        if (scheduled) return;
        scheduled = true;
        const scheduledEpoch = epoch;
        requestAnimationFrame(() => {
          if (scheduledEpoch !== epoch || this.disposed) return;
          scheduled = false;
          const text = pending;
          pending = '';
          this.terminal.write(text);
        });
      },
    };
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  get grid(): TerminalGrid {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  setGrid(grid: TerminalGrid): void {
    if (grid.cols !== this.terminal.cols || grid.rows !== this.terminal.rows) {
      this.terminal.resize(grid.cols, grid.rows);
    }
    this.stickToBottom = true;
    this.layout();
  }

  setZoom(zoom: TerminalZoom): void {
    this.zoom = zoom === 'fit' ? 'fit' : clampFontSize(zoom);
    this.layout();
  }

  zoomBy(delta: number): void {
    this.setZoom(Math.round(this.fontSize) + delta);
  }

  get fontSize(): number {
    return this.terminal.options.fontSize ?? INITIAL_FONT_SIZE;
  }

  /** The grid that would fill this viewport at a comfortable reading size. */
  gridForViewport(fontSize: number): TerminalGrid {
    const cell = this.measureCell();
    const scale = fontSize / this.fontSize;
    return gridForArea({
      width: this.viewport.clientWidth - PADDING_PX * 2,
      height: this.viewport.clientHeight - PADDING_PX * 2,
      cellWidth: cell.width * scale,
      cellHeight: cell.height * scale,
    });
  }

  setTheme(theme: ITheme): void {
    this.terminal.options.theme = theme;
  }

  get modes(): TerminalInputModes {
    return {
      applicationCursorKeys: this.terminal.modes.applicationCursorKeysMode,
      bracketedPaste: this.terminal.modes.bracketedPasteMode,
    };
  }

  focus(): void {
    this.terminal.focus();
  }

  jumpToLatest(): void {
    this.stopMomentum();
    this.stickToBottom = true;
    this.terminal.scrollToBottom();
    this.layout();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopMomentum();
    this.resizeObserver.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.terminal.dispose();
    this.stage.remove();
  }

  private measureCell(): { width: number; height: number } {
    const screen = this.stage.querySelector<HTMLElement>('.xterm-screen');
    const rect = screen?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      // Not laid out yet: fall back to typical monospace proportions.
      return { width: this.fontSize * 0.6, height: this.fontSize * 1.2 };
    }
    return { width: rect.width / this.terminal.cols, height: rect.height / this.terminal.rows };
  }

  private applyFontSize(size: number): void {
    if (Math.abs(size - this.fontSize) < 0.01) return;
    this.terminal.options.fontSize = size;
  }

  /** Re-derives font size and vertical position from the viewport, grid and zoom. */
  private layout(): void {
    if (this.disposed) return;
    const available = this.viewport.clientWidth - PADDING_PX * 2;
    if (available <= 0) return;

    if (this.zoom === 'fit') {
      const cols = this.terminal.cols;
      let size = fitFontSize({
        availableWidth: available,
        cols,
        cellWidthRatio: this.measureCell().width / this.fontSize,
      });
      this.applyFontSize(size);
      // Glyph metrics are not perfectly linear in font size, so confirm against the real width.
      for (let pass = 0; pass < 6; pass += 1) {
        const width = this.measureCell().width * cols;
        if (width <= available + 0.5 || size <= clampFontSize(0)) break;
        size = clampFontSize(size - 0.25);
        this.applyFontSize(size);
      }
    } else {
      this.applyFontSize(this.zoom);
    }

    const maxOffset = this.maxOffset();
    this.offsetY = this.stickToBottom ? maxOffset : Math.min(this.offsetY, maxOffset);
    this.applyOffset();
    this.emitState();
  }

  private maxOffset(): number {
    return Math.max(0, this.stage.offsetHeight - this.viewport.clientHeight);
  }

  private applyOffset(): void {
    this.stage.style.transform = this.offsetY > 0 ? `translateY(${-this.offsetY}px)` : '';
  }

  private emitState(): void {
    const buffer = this.terminal.buffer.active;
    this.options.onState({
      fontSize: this.fontSize,
      zoom: this.zoom,
      scrolledBack: buffer.viewportY < buffer.baseY,
    });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    // With a selection, Ctrl/Cmd+C copies instead of interrupting the agent.
    if (modifier && key === 'c' && this.terminal.hasSelection()) {
      void navigator.clipboard?.writeText(this.terminal.getSelection()).catch(() => {});
      this.terminal.clearSelection();
      event.preventDefault();
      return false;
    }
    // Let the browser run its paste; xterm turns the paste event into (bracketed) input.
    if (modifier && key === 'v') return false;
    return true;
  }

  /**
   * One-finger vertical drags scroll the output (with momentum), two fingers pinch the font
   * size, and horizontal drags are left to the viewport's native scrolling.
   */
  private attachGestures(): void {
    const viewport = this.viewport;
    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let panning = false;
    let pinch: { distance: number; fontSize: number } | null = null;

    const distance = (touches: TouchList): number => {
      const [a, b] = [touches[0]!, touches[1]!];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onStart = (event: TouchEvent): void => {
      this.stopMomentum();
      if (event.touches.length === 2) {
        panning = false;
        pinch = { distance: distance(event.touches), fontSize: this.fontSize };
        return;
      }
      pinch = null;
      panning = event.touches.length === 1;
      lastY = event.touches[0]?.clientY ?? 0;
      lastTime = event.timeStamp;
      velocity = 0;
    };

    const onMove = (event: TouchEvent): void => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        const next = pinchFontSize(pinch.fontSize, distance(event.touches) / pinch.distance);
        if (next !== this.fontSize) this.setZoom(next);
        return;
      }
      const touch = event.touches[0];
      if (!panning || !touch) return;
      const dy = touch.clientY - lastY;
      const dt = Math.max(1, event.timeStamp - lastTime);
      lastY = touch.clientY;
      lastTime = event.timeStamp;
      velocity = 0.7 * (dy / dt) + 0.3 * velocity;
      this.panBy(dy);
    };

    const onEnd = (event: TouchEvent): void => {
      if (event.touches.length > 0) {
        // One finger of a pinch lifted: do not treat the remaining one as a pan.
        pinch = null;
        panning = false;
        return;
      }
      pinch = null;
      if (!panning) return;
      panning = false;
      if (event.timeStamp - lastTime < 80 && Math.abs(velocity) > MIN_VELOCITY) {
        this.startMomentum(velocity);
      }
    };

    const onWheel = (event: WheelEvent): void => {
      // Only when the terminal is taller than the viewport is there anything for us to move;
      // otherwise xterm owns the wheel (scrollback, or mouse reports to the program).
      if (this.maxOffset() <= 0 || event.ctrlKey) return;
      const consumed = this.shiftOffset(-event.deltaY);
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    viewport.addEventListener('touchstart', onStart, { passive: true });
    viewport.addEventListener('touchmove', onMove, { passive: false });
    viewport.addEventListener('touchend', onEnd, { passive: true });
    viewport.addEventListener('touchcancel', onEnd, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: false, capture: true });
    this.cleanups.push(() => {
      viewport.removeEventListener('touchstart', onStart);
      viewport.removeEventListener('touchmove', onMove);
      viewport.removeEventListener('touchend', onEnd);
      viewport.removeEventListener('touchcancel', onEnd);
      viewport.removeEventListener('wheel', onWheel, { capture: true });
    });
  }

  /** Moves the visible window; returns whether any of `dy` (positive reveals the top) applied. */
  private shiftOffset(dy: number): boolean {
    const next = Math.min(this.maxOffset(), Math.max(0, this.offsetY - dy));
    if (next === this.offsetY) return false;
    this.offsetY = next;
    this.stickToBottom = next >= this.maxOffset();
    this.applyOffset();
    return true;
  }

  /**
   * Scrolls by `dy` pixels of finger travel (positive: towards earlier output). The visible
   * window moves over the terminal's own rows first, then the scrollback takes over.
   */
  private panBy(dy: number): boolean {
    if (dy === 0) return false;
    const buffer = this.terminal.buffer.active;
    const atLiveEnd = buffer.viewportY >= buffer.baseY;
    // Towards the live end, the scrollback is exhausted before the window moves down again.
    if (dy > 0 || atLiveEnd) {
      if (this.shiftOffset(dy)) return true;
    }
    const cellHeight = this.measureCell().height;
    this.scrollRemainder += -dy / cellHeight;
    const lines = Math.trunc(this.scrollRemainder);
    if (lines === 0) return true;
    this.scrollRemainder -= lines;
    const before = buffer.viewportY;
    this.terminal.scrollLines(lines);
    const moved = this.terminal.buffer.active.viewportY !== before;
    if (!moved) this.scrollRemainder = 0;
    this.emitState();
    return moved;
  }

  private startMomentum(initialVelocity: number): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let velocity = initialVelocity;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(48, now - last);
      last = now;
      velocity *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(velocity) < MIN_VELOCITY || !this.panBy(velocity * dt)) {
        this.momentumFrame = 0;
        return;
      }
      this.momentumFrame = requestAnimationFrame(step);
    };
    this.momentumFrame = requestAnimationFrame(step);
  }

  private stopMomentum(): void {
    if (this.momentumFrame) cancelAnimationFrame(this.momentumFrame);
    this.momentumFrame = 0;
    this.scrollRemainder = 0;
  }
}
