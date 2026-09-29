import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cssColorToHex } from '@core/primitives/styling/browser/cssVars';

async function getPtyModule() {
  return import('@core/features/terminals/api/browser/pty/pty');
}

/** Counts writes to `terminal.options.theme`; each one makes xterm repaint every row. */
function countThemeWrites(terminal: { options: object }): { count: number } {
  const writes = { count: 0 };
  const options = terminal.options as { theme?: unknown };
  let theme = options.theme;
  Object.defineProperty(options, 'theme', {
    configurable: true,
    get: () => theme,
    set: (next: unknown) => {
      writes.count += 1;
      theme = next;
    },
  });
  return writes;
}

describe('terminal theme application', () => {
  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn(() => () => {}),
      eventSend: vi.fn(),
      invoke: vi.fn(() => Promise.resolve({ success: true, data: null })),
    });
    document.documentElement.style.setProperty('--xterm-bg', '#101010');
    document.documentElement.style.setProperty('--xterm-fg', '#f0f0f0');
  });

  afterEach(async () => {
    const { disposeAllPtys } = await getPtyModule();
    disposeAllPtys();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('skips repaints when a render passes an equal theme or CSS colors are unchanged', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('theme-noop', { paddingBottom: 4 });
    const writes = countThemeWrites(pty.terminal);

    pty.setTheme({ paddingBottom: 4 });
    pty.refreshTheme();
    expect(writes.count).toBe(0);

    pty.setTheme({ paddingBottom: 4, override: { background: '#202020' } });
    expect(writes.count).toBe(1);
    expect(pty.terminal.element?.style.backgroundColor).toBe('rgb(32, 32, 32)');

    document.documentElement.style.setProperty('--xterm-fg', '#e0e0e0');
    pty.refreshTheme();
    expect(writes.count).toBe(2);
  });

  it('converts CSS colors to hex consistently across repeated and invalid inputs', () => {
    expect(cssColorToHex('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(cssColorToHex(' rgb(255, 0, 0) ')).toBe('#ff0000');
    expect(cssColorToHex('rgba(0, 0, 255, 0.5)')).toMatch(/^#0000ff[0-9a-f]{2}$/);
    // An unparsable color never inherits the previous conversion's result.
    expect(cssColorToHex('not-a-color')).toBe('#000000');
    expect(cssColorToHex('hsl(120 100% 25%)')).toBe('#008000');
  });
});
