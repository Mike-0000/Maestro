import { err, ok, type Result } from '@emdash/shared';
import { nativeImage, type NativeImage, type WebContents } from 'electron';
import {
  buildAXOutline,
  fitWithin,
  frameUntrustedContent,
  httpOrigin,
  type AXNodeLike,
  type BrowserAction,
  type BrowserActionTarget,
  type BrowserActResult,
  type BrowserAutomationError,
  type BrowserImage,
  type BrowserObservation,
  type BrowserObserveInput,
} from '@core/primitives/browser/api';

/**
 * Executes observations and actions against one bound webview through Electron's CDP debugger and
 * isolated-world scripts. It enforces no policy: `BrowserControlService` authorizes every call
 * before it gets here. Page script never runs in the page's own world, so the page cannot
 * intercept what Chorus reads.
 */

const CDP_PROTOCOL_VERSION = '1.3';
/** Isolated world id for Chorus reads; any non-zero id is separate from the page's world. */
const CHORUS_WORLD_ID = 4217;
const DEFAULT_SCREENSHOT_EDGE = 1280;
const DEFAULT_JPEG_QUALITY = 70;
const TEXT_MAX_CHARS = 20_000;
const OUTLINE_MAX_CHARS = 12_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 8_000;
const WAIT_DEFAULT_MS = 5_000;
const WAIT_MAX_MS = 15_000;
const WAIT_POLL_MS = 250;

type SnapshotState = {
  generation: number;
  refs: Map<string, number>;
  /** Last screenshot size and the CSS viewport it showed, to map screenshot coordinates. */
  shot: { width: number; height: number; cssWidth: number; cssHeight: number } | null;
};

type Point = { x: number; y: number };

type BoxModel = { model: { content: number[] } };

export class BrowserAutomation {
  private readonly states = new Map<number, SnapshotState>();

  /** Drops per-page state and releases the debugger. */
  release(webContents: WebContents): void {
    this.states.delete(webContents.id);
    if (webContents.isDestroyed()) return;
    try {
      if (webContents.debugger.isAttached()) webContents.debugger.detach();
    } catch {
      // Already detached by the page going away or DevTools taking over.
    }
  }

  async observe(
    webContents: WebContents,
    input: BrowserObserveInput
  ): Promise<Result<BrowserObservation, BrowserAutomationError>> {
    const base = { url: webContents.getURL(), title: webContents.getTitle() };
    const origin = httpOrigin(base.url) ?? base.url;
    try {
      switch (input.mode) {
        case 'screenshot': {
          const image = await this.screenshot(webContents, input.maxEdge, input.quality);
          if (!image)
            return err({ type: 'capture-failed', message: 'The page could not be captured.' });
          return ok({ ...base, image });
        }
        case 'outline': {
          const cdp = this.cdp(webContents);
          if (!cdp.success) return cdp;
          const tree = (await cdp.data('Accessibility.getFullAXTree', {})) as {
            nodes: AXNodeLike[];
          };
          const outline = buildAXOutline(tree.nodes ?? [], { maxChars: OUTLINE_MAX_CHARS });
          const state = this.state(webContents);
          state.generation += 1;
          state.refs = outline.refs;
          const body = outline.text || '(no accessible content)';
          return ok({
            ...base,
            generation: state.generation,
            truncated: outline.truncated,
            text: frameUntrustedContent(body, {
              origin,
              kind: 'outline',
              truncated: outline.truncated,
            }),
          });
        }
        case 'text': {
          const raw = await this.isolated<string>(
            webContents,
            'document.body ? document.body.innerText : ""'
          );
          const text = typeof raw === 'string' ? raw : '';
          const truncated = text.length > TEXT_MAX_CHARS;
          return ok({
            ...base,
            truncated,
            text: frameUntrustedContent(truncated ? text.slice(0, TEXT_MAX_CHARS) : text, {
              origin,
              kind: 'text',
              truncated,
            }),
          });
        }
      }
    } catch (error) {
      return err({ type: 'failed', message: describeError(error) });
    }
  }

  async act(
    webContents: WebContents,
    action: BrowserAction
  ): Promise<Result<BrowserActResult, BrowserAutomationError>> {
    const before = await this.fingerprint(webContents);
    try {
      const outcome = await this.perform(webContents, action);
      if (!outcome.success) return outcome;
      if (action.kind !== 'wait') await this.settle(webContents);
      const after = await this.fingerprint(webContents);
      return ok({
        url: webContents.getURL(),
        title: webContents.getTitle(),
        changed: before !== after,
        ...(outcome.data ? { note: outcome.data } : {}),
      });
    } catch (error) {
      return err({ type: 'failed', message: describeError(error) });
    }
  }

  private async perform(
    webContents: WebContents,
    action: BrowserAction
  ): Promise<Result<string | undefined, BrowserAutomationError>> {
    switch (action.kind) {
      case 'navigate':
        return this.navigate(webContents, action.url);
      case 'reload':
        webContents.reload();
        return ok(undefined);
      case 'back':
        if (!webContents.navigationHistory.canGoBack()) return ok('No page to go back to.');
        webContents.navigationHistory.goBack();
        return ok(undefined);
      case 'forward':
        if (!webContents.navigationHistory.canGoForward()) return ok('No page to go forward to.');
        webContents.navigationHistory.goForward();
        return ok(undefined);
      case 'click': {
        const point = await this.resolvePoint(webContents, action.target);
        if (!point.success) return point;
        await this.click(webContents, point.data);
        return ok(undefined);
      }
      case 'type': {
        if (action.target) {
          const focused = await this.focusTarget(webContents, action.target);
          if (!focused.success) return focused;
        }
        const cdp = this.cdp(webContents);
        if (!cdp.success) return cdp;
        await this.insertText(cdp.data, action.text);
        if (action.submit) await this.pressKey(webContents, 'Enter');
        return ok(undefined);
      }
      case 'press':
        if (!KEY_CODES[action.key] && !isSingleCharacter(action.key)) {
          return err({ type: 'failed', message: `Unsupported key "${action.key}".` });
        }
        await this.pressKey(webContents, action.key);
        return ok(undefined);
      case 'scroll': {
        let point: Point | null = null;
        if (action.target) {
          const resolved = await this.resolvePoint(webContents, action.target);
          if (!resolved.success) return resolved;
          point = resolved.data;
        } else {
          point = await this.viewportCenter(webContents);
        }
        const cdp = this.cdp(webContents);
        if (!cdp.success) return cdp;
        await cdp.data('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: 0,
          deltaY: clamp(action.deltaY, -5000, 5000),
        });
        return ok(undefined);
      }
      case 'select':
        return this.select(webContents, action.target, action.value);
      case 'wait':
        return this.waitFor(webContents, action);
    }
  }

  private async navigate(
    webContents: WebContents,
    url: string
  ): Promise<Result<string | undefined, BrowserAutomationError>> {
    const loaded = webContents.loadURL(url).then(
      () => 'loaded' as const,
      (error: unknown) => error
    );
    const outcome = await Promise.race([loaded, delay(NAVIGATION_TIMEOUT_MS).then(() => 'slow')]);
    if (outcome === 'loaded') return ok(undefined);
    if (outcome === 'slow') return ok('The page is still loading.');
    // ERR_ABORTED means a redirect or a second navigation replaced this one.
    if (describeError(outcome).includes('ERR_ABORTED')) return ok(undefined);
    return err({ type: 'failed', message: `Navigation failed: ${describeError(outcome)}` });
  }

  private async screenshot(
    webContents: WebContents,
    maxEdge = DEFAULT_SCREENSHOT_EDGE,
    quality = DEFAULT_JPEG_QUALITY
  ): Promise<BrowserImage | null> {
    const image = await this.capture(webContents);
    if (!image) return null;

    const size = image.getSize();
    const target = fitWithin(size, maxEdge);
    const resized =
      target.width === size.width ? image : image.resize({ ...target, quality: 'good' });
    const viewport = await this.viewportSize(webContents);
    this.state(webContents).shot = {
      width: target.width,
      height: target.height,
      cssWidth: viewport?.width ?? target.width,
      cssHeight: viewport?.height ?? target.height,
    };
    return {
      mediaType: 'image/jpeg',
      data: resized.toJPEG(clamp(Math.round(quality), 30, 90)).toString('base64'),
      width: target.width,
      height: target.height,
    };
  }

  /**
   * Types into the focused element. A guest that is not the focused widget (a hidden canvas page)
   * drops `Input.insertText`, so the result is checked and, when nothing changed, the text is
   * inserted through the element itself with the input events frameworks listen for.
   */
  private async insertText(
    send: (method: string, params?: object) => Promise<unknown>,
    text: string
  ): Promise<void> {
    const readValue = async () =>
      (
        (await send('Runtime.evaluate', {
          expression: FOCUSED_VALUE_EXPRESSION,
          returnByValue: true,
        })) as { result: { value?: unknown } }
      ).result.value;
    const before = await readValue();
    await send('Input.insertText', { text });
    if ((await readValue()) !== before) return;
    await send('Runtime.evaluate', {
      expression: `(${insertIntoFocused.toString()})(${JSON.stringify(text)})`,
      returnByValue: true,
    });
  }

  /** A small JPEG of the page for the canvas tile while it is not shown live. */
  async preview(webContents: WebContents, maxEdge: number): Promise<BrowserImage | null> {
    const image = await this.capture(webContents);
    if (!image) return null;
    const size = fitWithin(image.getSize(), maxEdge);
    return {
      mediaType: 'image/jpeg',
      data: image
        .resize({ ...size, quality: 'good' })
        .toJPEG(60)
        .toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  /**
   * Compositor capture, falling back to CDP. Both are bounded: a guest that is not producing
   * frames can leave either call pending forever.
   */
  private async capture(webContents: WebContents): Promise<NativeImage | null> {
    const direct = await withTimeout(
      webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      CAPTURE_TIMEOUT_MS
    ).catch(() => null);
    if (direct && !direct.isEmpty()) return direct;
    const fallback = await withTimeout(this.cdpScreenshot(webContents), CAPTURE_TIMEOUT_MS).catch(
      () => null
    );
    return fallback && !fallback.isEmpty() ? fallback : null;
  }

  /** CDP capture works for guests the compositor has stopped painting (hidden tiles). */
  private async cdpScreenshot(webContents: WebContents): Promise<NativeImage | null> {
    const cdp = this.cdp(webContents);
    if (!cdp.success) return null;
    try {
      const shot = (await cdp.data('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    } catch {
      return null;
    }
  }

  private async resolvePoint(
    webContents: WebContents,
    target: BrowserActionTarget
  ): Promise<Result<Point, BrowserAutomationError>> {
    if ('x' in target) {
      const shot = this.state(webContents).shot;
      if (!shot) return ok({ x: target.x, y: target.y });
      return ok({
        x: (clamp(target.x, 0, shot.width) * shot.cssWidth) / shot.width,
        y: (clamp(target.y, 0, shot.height) * shot.cssHeight) / shot.height,
      });
    }
    const backendNodeId = this.state(webContents).refs.get(target.ref);
    if (backendNodeId === undefined) {
      return err({
        type: 'stale-ref',
        message: `Unknown ref "${target.ref}". Take a fresh outline first.`,
      });
    }
    const cdp = this.cdp(webContents);
    if (!cdp.success) return cdp;
    try {
      await cdp.data('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
      const box = (await cdp.data('DOM.getBoxModel', { backendNodeId })) as BoxModel;
      return ok(quadCenter(box.model.content));
    } catch {
      return err({
        type: 'stale-ref',
        message: `Element ${target.ref} is no longer on the page. Take a fresh outline.`,
      });
    }
  }

  private async focusTarget(
    webContents: WebContents,
    target: BrowserActionTarget
  ): Promise<Result<undefined, BrowserAutomationError>> {
    if ('x' in target) {
      const point = await this.resolvePoint(webContents, target);
      if (!point.success) return point;
      await this.click(webContents, point.data);
      return ok(undefined);
    }
    const point = await this.resolvePoint(webContents, target);
    if (!point.success) return point;
    const backendNodeId = this.state(webContents).refs.get(target.ref);
    const cdp = this.cdp(webContents);
    if (!cdp.success) return cdp;
    try {
      await cdp.data('DOM.focus', { backendNodeId });
      // Replace the field's content rather than appending to it.
      const resolved = (await cdp.data('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (resolved.object.objectId) {
        await cdp.data('Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          functionDeclaration:
            'function(){ if (typeof this.select === "function") this.select(); else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }',
        });
        await cdp.data('Runtime.releaseObject', { objectId: resolved.object.objectId });
      }
      return ok(undefined);
    } catch {
      await this.click(webContents, point.data);
      return ok(undefined);
    }
  }

  private async select(
    webContents: WebContents,
    target: BrowserActionTarget,
    value: string
  ): Promise<Result<string | undefined, BrowserAutomationError>> {
    if ('x' in target) {
      return err({ type: 'failed', message: 'select needs an outline ref, not coordinates.' });
    }
    const point = await this.resolvePoint(webContents, target);
    if (!point.success) return point;
    const backendNodeId = this.state(webContents).refs.get(target.ref);
    const cdp = this.cdp(webContents);
    if (!cdp.success) return cdp;
    const resolved = (await cdp.data('DOM.resolveNode', { backendNodeId })) as {
      object: { objectId?: string };
    };
    if (!resolved.object.objectId) return err({ type: 'stale-ref', message: 'Element is gone.' });
    const result = (await cdp.data('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      arguments: [{ value }],
      returnByValue: true,
      functionDeclaration: `function(wanted){
        if (!(this instanceof HTMLSelectElement)) return 'not-select';
        const needle = String(wanted).trim().toLowerCase();
        const option = Array.from(this.options).find((o) =>
          o.value === wanted || o.label.trim().toLowerCase() === needle ||
          o.text.trim().toLowerCase() === needle);
        if (!option) return 'no-option';
        this.value = option.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      }`,
    })) as { result: { value?: string } };
    await cdp.data('Runtime.releaseObject', { objectId: resolved.object.objectId });
    const status = result.result.value;
    if (status === 'not-select') {
      return err({ type: 'failed', message: `${target.ref} is not a <select>; click it instead.` });
    }
    if (status === 'no-option') {
      return err({ type: 'not-found', message: `No option "${value}" in ${target.ref}.` });
    }
    return ok(undefined);
  }

  private async waitFor(
    webContents: WebContents,
    action: Extract<BrowserAction, { kind: 'wait' }>
  ): Promise<Result<string | undefined, BrowserAutomationError>> {
    const timeoutMs = clamp(action.timeoutMs ?? WAIT_DEFAULT_MS, WAIT_POLL_MS, WAIT_MAX_MS);
    const deadline = Date.now() + timeoutMs;
    const needle = action.text?.toLowerCase();
    if (!needle && !action.urlIncludes) {
      await delay(Math.min(timeoutMs, 2_000));
      return ok(undefined);
    }
    while (Date.now() < deadline) {
      if (webContents.isDestroyed()) return err({ type: 'not-bound', message: 'Browser closed.' });
      const urlOk = !action.urlIncludes || webContents.getURL().includes(action.urlIncludes);
      let textOk = true;
      if (needle) {
        const text = await this.isolated<string>(
          webContents,
          'document.body ? document.body.innerText : ""'
        ).catch(() => '');
        textOk = typeof text === 'string' && text.toLowerCase().includes(needle);
      }
      if (urlOk && textOk) return ok(undefined);
      await delay(WAIT_POLL_MS);
    }
    return err({ type: 'timeout', message: `Waited ${timeoutMs}ms; the condition never held.` });
  }

  private async click(webContents: WebContents, point: Point): Promise<void> {
    const cdp = this.cdp(webContents);
    if (!cdp.success) {
      // Without CDP (DevTools open), fall back to synthesized input events.
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      webContents.sendInputEvent({ type: 'mouseMove', x, y });
      webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return;
    }
    const base = { x: point.x, y: point.y };
    await cdp.data('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await cdp.data('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...base,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.data('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...base,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  private async pressKey(webContents: WebContents, key: string): Promise<void> {
    const cdp = this.cdp(webContents);
    const code = KEY_CODES[key];
    const text =
      key === 'Enter' ? '\r' : key === 'Space' ? ' ' : isSingleCharacter(key) ? key : undefined;
    if (!cdp.success) {
      webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      if (text) webContents.sendInputEvent({ type: 'char', keyCode: text });
      webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      return;
    }
    const common = {
      key,
      code: code?.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      windowsVirtualKeyCode: code?.keyCode ?? key.toUpperCase().charCodeAt(0),
    };
    await cdp.data('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      ...common,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await cdp.data('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  /** Waits briefly for a navigation an action may have started. */
  private async settle(webContents: WebContents): Promise<void> {
    await delay(150);
    if (webContents.isDestroyed() || !webContents.isLoading()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, SETTLE_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        if (!webContents.isDestroyed()) webContents.off('did-stop-loading', done);
        resolve();
      }
      webContents.once('did-stop-loading', done);
    });
  }

  private async fingerprint(webContents: WebContents): Promise<string> {
    if (webContents.isDestroyed()) return '';
    const text = await this.isolated<string>(
      webContents,
      'document.body ? String(document.body.innerText.length) + ":" + document.body.innerText.slice(0, 400) : ""'
    ).catch(() => '');
    return `${webContents.getURL()}|${webContents.getTitle()}|${String(text)}`;
  }

  private async viewportSize(
    webContents: WebContents
  ): Promise<{ width: number; height: number } | null> {
    const size = await this.isolated<[number, number]>(
      webContents,
      '[window.innerWidth, window.innerHeight]'
    ).catch(() => null);
    if (!Array.isArray(size) || size.length !== 2) return null;
    const [width, height] = size;
    if (typeof width !== 'number' || typeof height !== 'number') return null;
    return { width, height };
  }

  private async viewportCenter(webContents: WebContents): Promise<Point> {
    const size = await this.viewportSize(webContents);
    return size ? { x: size.width / 2, y: size.height / 2 } : { x: 400, y: 300 };
  }

  private isolated<T>(webContents: WebContents, code: string): Promise<T> {
    return webContents.executeJavaScriptInIsolatedWorld(CHORUS_WORLD_ID, [{ code }]) as Promise<T>;
  }

  private state(webContents: WebContents): SnapshotState {
    let state = this.states.get(webContents.id);
    if (!state) {
      state = { generation: 0, refs: new Map(), shot: null };
      this.states.set(webContents.id, state);
      webContents.once('destroyed', () => this.states.delete(webContents.id));
      // A new document invalidates every ref.
      webContents.on('did-navigate', () => {
        const current = this.states.get(webContents.id);
        if (current) current.refs = new Map();
      });
    }
    return state;
  }

  private cdp(
    webContents: WebContents
  ): Result<(method: string, params?: object) => Promise<unknown>, BrowserAutomationError> {
    const dbg = webContents.debugger;
    try {
      if (!dbg.isAttached()) {
        dbg.attach(CDP_PROTOCOL_VERSION);
        // Canvas pages are usually not the focused widget (hidden, or the user is typing
        // elsewhere). Without focus emulation, focus() and Input.insertText are dropped.
        void dbg
          .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
          .catch(() => {});
      }
    } catch {
      return err({
        type: 'failed',
        message: 'Browser automation is unavailable while DevTools is open on this page.',
      });
    }
    return ok((method: string, params?: object) => dbg.sendCommand(method, params));
  }
}

const KEY_CODES: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32 },
};

export function quadCenter(quad: number[]): Point {
  let x = 0;
  let y = 0;
  for (let index = 0; index + 1 < quad.length; index += 2) {
    x += quad[index] ?? 0;
    y += quad[index + 1] ?? 0;
  }
  const points = Math.max(1, Math.floor(quad.length / 2));
  return { x: x / points, y: y / points };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One user-perceived character (counted in code points, so an emoji counts once). */
function isSingleCharacter(key: string): boolean {
  return Array.from(key).length === 1;
}

const CAPTURE_TIMEOUT_MS = 3_000;

/** Resolves null when `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** The focused element's text (value or editable content), to detect a dropped insertText. */
const FOCUSED_VALUE_EXPRESSION =
  '(() => { const el = document.activeElement; if (!el) return null; ' +
  "return 'value' in el ? String(el.value) : el.isContentEditable ? el.textContent : null; })()";

/** Runs in the page: inserts `text` at the focused element's selection, firing input events. */
function insertIntoFocused(text: string): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.setRangeText(
        text,
        el.selectionStart ?? el.value.length,
        el.selectionEnd ?? el.value.length,
        'end'
      );
    } catch {
      // Inputs without a text selection (email, number): replace through the value setter.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
    }
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el.isContentEditable) return document.execCommand('insertText', false, text);
  return false;
}
