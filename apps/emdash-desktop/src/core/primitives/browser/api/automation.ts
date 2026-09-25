/**
 * Types and pure helpers for model-driven browser automation (conductor tools and the agent MCP
 * server). The main process executes everything; these shapes cross the Wire boundary.
 */

/** Who drives a browser. Agents are scoped to their own task by the control server. */
export type BrowserAutomationActor =
  | { kind: 'conductor' }
  | { kind: 'agent'; conversationId: string; name?: string };

export type BrowserObserveMode = 'screenshot' | 'outline' | 'text';

export type BrowserObserveInput = {
  browserId: string;
  mode: BrowserObserveMode;
  /** Long edge of the returned screenshot in pixels (clamped to 160..1568). */
  maxEdge?: number;
  /** JPEG quality 30..90. */
  quality?: number;
  /** Include recent console errors and failed loads in the result. */
  includeConsole?: boolean;
};

export type BrowserImage = {
  mediaType: 'image/jpeg';
  /** Base64 without a data-URL prefix. */
  data: string;
  width: number;
  height: number;
};

export type BrowserObservation = {
  url: string;
  title: string;
  image?: BrowserImage;
  /** Outline or text, already framed as untrusted page content. */
  text?: string;
  /** Snapshot generation that outline refs belong to. */
  generation?: number;
  truncated?: boolean;
  console?: BrowserConsoleEntry[];
};

export type BrowserConsoleEntry = {
  at: number;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source?: string;
};

export type BrowserActionTarget = { ref: string } | { x: number; y: number };

export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'reload' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'click'; target: BrowserActionTarget }
  | { kind: 'type'; target?: BrowserActionTarget; text: string; submit?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; target?: BrowserActionTarget; deltaY: number }
  | { kind: 'select'; target: BrowserActionTarget; value: string }
  | { kind: 'wait'; text?: string; urlIncludes?: string; timeoutMs?: number };

export type BrowserActInput = {
  browserId: string;
  action: BrowserAction;
};

export type BrowserActResult = {
  url: string;
  title: string;
  /** True when the URL or the page's visible text changed after the action. */
  changed: boolean;
  note?: string;
};

export type BrowserAutomationError =
  | { type: 'not-bound'; message: string }
  | { type: 'not-controllable'; message: string }
  | { type: 'origin-denied'; message: string; url: string }
  | { type: 'stale-ref'; message: string }
  | { type: 'not-found'; message: string }
  | { type: 'timeout'; message: string }
  | { type: 'rate-limited'; message: string }
  | { type: 'busy'; message: string }
  | { type: 'disabled'; message: string }
  | { type: 'capture-failed'; message: string }
  | { type: 'failed'; message: string };

export const BROWSER_ACTION_KINDS = [
  'navigate',
  'reload',
  'back',
  'forward',
  'click',
  'type',
  'press',
  'scroll',
  'select',
  'wait',
] as const satisfies readonly BrowserAction['kind'][];

/** Actions that change page state; the rest only read or wait. */
export function isMutatingBrowserAction(action: BrowserAction): boolean {
  return action.kind !== 'wait' && action.kind !== 'scroll';
}

export const MODEL_SCREENSHOT_MAX_EDGE = 1568;
export const PREVIEW_SCREENSHOT_MAX_EDGE = 480;
const MIN_SCREENSHOT_EDGE = 160;

/** Scales a size down (never up) so its longer edge is at most `maxEdge`. */
export function fitWithin(
  size: { width: number; height: number },
  maxEdge: number
): { width: number; height: number } {
  const edge = Math.min(
    Math.max(Math.round(maxEdge), MIN_SCREENSHOT_EDGE),
    MODEL_SCREENSHOT_MAX_EDGE
  );
  const longest = Math.max(size.width, size.height);
  if (longest <= edge || longest === 0) {
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
  }
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Anthropic's documented estimate of the input tokens an image costs. */
export function estimateImageTokens(image: { width: number; height: number }): number {
  return Math.ceil((image.width * image.height) / 750);
}

/**
 * Wraps page-derived text so a model treats it as data. Page text cannot close the frame early:
 * angle brackets inside it are escaped.
 */
export function frameUntrustedContent(
  body: string,
  meta: { origin: string; kind: string; truncated?: boolean }
): string {
  const escaped = body.replace(/</g, '‹').replace(/>/g, '›');
  const origin = meta.origin.replace(/["<>]/g, '');
  return `<untrusted_page_content origin="${origin}" kind="${meta.kind}" truncated="${meta.truncated ? 'true' : 'false'}">\n${escaped}\n</untrusted_page_content>`;
}

/** Origin of a URL for display and policy (`null` for non-http(s) URLs). */
export function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
