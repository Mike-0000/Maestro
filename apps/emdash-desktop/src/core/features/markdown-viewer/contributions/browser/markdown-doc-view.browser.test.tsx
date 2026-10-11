import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalLinkProvider } from '@core/primitives/external-links/browser';
import { MarkdownDocView } from './markdown-doc-view';
import '@emdash/ui/style.css';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SAMPLE = [
  '# Migration plan',
  '',
  'Read the [design notes](./notes/design.md), the [spec](https://example.com/spec) and [the script](run.sh).',
  '',
  '- [x] Write the plan',
  '- [ ] Review it',
  '',
  '| Step | Owner |',
  '| ---- | ----- |',
  '| Backfill | Nova |',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  '![before](img/before.png)',
  '',
  '<script>window.pwned = true</script>',
  '<img src="x" onerror="window.pwned = true">',
  '',
].join('\n');

type ReadResult =
  | { success: true; data: { path: string; name: string; content: string } }
  | { success: false; error: { code: string; message: string } };

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readImage: vi.fn(),
  openMarkdownPath: vi.fn(),
  stopWatching: vi.fn(),
  fileChanged: undefined as (() => void) | undefined,
}));

vi.mock('../../api/browser/client', () => ({
  getMarkdownViewerClient: async () => ({ read: mocks.read, readImage: mocks.readImage }),
}));

vi.mock('@core/features/files/api/browser/file-content', () => ({
  watchFileContent: async (_ref: unknown, onChange: () => void) => {
    mocks.fileChanged = onChange;
    return mocks.stopWatching;
  },
}));

vi.mock('../../api/browser/open-markdown-doc', () => ({
  openMarkdownPath: mocks.openMarkdownPath,
}));

const doc = { projectId: 'p1', workspaceId: 'ws1', taskId: 't1', path: '/repo/docs/plan.md' };

function content(text: string): ReadResult {
  return { success: true, data: { path: doc.path, name: 'plan.md', content: text } };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('MarkdownDocView', () => {
  let host: HTMLDivElement;
  let root: Root;
  const openExternal = vi.fn();

  const mount = async () => {
    await act(async () => {
      root.render(
        <ExternalLinkProvider openExternalLink={openExternal}>
          <MarkdownDocView doc={doc} />
        </ExternalLinkProvider>
      );
    });
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fileChanged = undefined;
    mocks.read.mockResolvedValue(content(SAMPLE));
    mocks.readImage.mockResolvedValue({ success: true, data: { dataUrl: PNG_DATA_URL } });
    mocks.openMarkdownPath.mockResolvedValue(true);
    delete (window as { pwned?: boolean }).pwned;
    host = document.createElement('div');
    host.style.height = '600px';
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders headings, task lists, tables and highlighted code from the checked read', async () => {
    await mount();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Migration plan'));

    expect(mocks.read).toHaveBeenCalledWith({
      projectId: 'p1',
      workspaceId: 'ws1',
      path: '/repo/docs/plan.md',
    });
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    // Read-only: a task cannot be ticked from the viewer.
    expect(boxes.every((box) => box.disabled || box.readOnly)).toBe(true);
    expect([...host.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Step',
      'Owner',
    ]);
    expect(host.querySelector('td')?.textContent).toBe('Backfill');
    expect(host.querySelector('pre')?.textContent).toContain('const answer: number = 42;');
    // The highlighter loads lazily and then colours the tokens.
    await vi.waitFor(() =>
      expect(host.querySelectorAll('pre span[style*="color"]').length).toBeGreaterThan(1)
    );
    // Nothing in the viewer is editable.
    expect(host.querySelector('textarea, [contenteditable="true"]')).toBeNull();
  });

  it('keeps harmless embedded HTML and drops what could run or leave the viewer', async () => {
    mocks.read.mockResolvedValue(
      content(
        [
          '# Notes',
          '',
          '<details><summary>More</summary>Hidden <kbd>Ctrl</kbd> text</details>',
          '',
          '<script>window.pwned = true</script>',
          '<iframe src="https://example.com"></iframe>',
          '<form action="https://example.com"><input name="q"><button>Send</button></form>',
          '<a href="javascript:window.pwned = true">run</a>',
          '<p style="position:fixed" onclick="window.pwned = true">styled</p>',
          '',
        ].join('\n')
      )
    );
    await mount();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Notes'));

    // Allowed HTML survives, so the sanitizer is what removed the rest.
    expect(host.querySelector('details summary')?.textContent).toBe('More');
    expect(host.querySelector('kbd')?.textContent).toBe('Ctrl');
    expect(host.querySelector('script, iframe, form, button')).toBeNull();
    expect(host.innerHTML).not.toContain('javascript:');
    expect(host.innerHTML).not.toContain('position:fixed');
    expect(host.innerHTML).not.toContain('onclick');
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it('does not let a middle click follow a link into a window of its own', async () => {
    await mount();
    await vi.waitFor(() => expect(host.querySelectorAll('a').length).toBe(3));
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    host.querySelector('a')?.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(mocks.openMarkdownPath).not.toHaveBeenCalled();
  });

  it("loads an image through the checked read, against the document's folder", async () => {
    await mount();
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLImageElement>('img[alt="before"]')?.src).toBe(PNG_DATA_URL)
    );
    expect(mocks.readImage).toHaveBeenCalledWith({
      projectId: 'p1',
      workspaceId: 'ws1',
      from: '/repo/docs/plan.md',
      src: 'img/before.png',
    });
  });

  it('opens a linked Markdown file in the viewer and a web link outside the app', async () => {
    await mount();
    await vi.waitFor(() => expect(host.querySelectorAll('a').length).toBe(3));
    const [notes, spec, script] = [...host.querySelectorAll('a')];
    const click = (link: HTMLAnchorElement | undefined) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link?.dispatchEvent(event);
      return event.defaultPrevented;
    };

    // Every link is claimed, so none opens a window of its own.
    expect(click(notes)).toBe(true);
    expect(mocks.openMarkdownPath).toHaveBeenCalledWith(
      { projectId: 'p1', workspaceId: 'ws1', taskId: 't1' },
      './notes/design.md',
      { from: '/repo/docs/plan.md' }
    );
    expect(click(spec)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/spec');
    expect(click(script)).toBe(true);
    expect(mocks.openMarkdownPath).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('reloads when the file changes on disk', async () => {
    await mount();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Migration plan'));
    await vi.waitFor(() => expect(mocks.fileChanged).toBeDefined());

    mocks.read.mockResolvedValue(content('# Migration plan v2\n'));
    await act(async () => mocks.fileChanged?.());
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Migration plan v2'));
  });

  it('says why a file cannot be shown, and shows it again once it can', async () => {
    mocks.read.mockResolvedValue({
      success: false,
      error: { code: 'not-found', message: 'There is no file at /repo/docs/plan.md.' },
    });
    await mount();
    await vi.waitFor(() =>
      expect(host.textContent).toContain('There is no file at /repo/docs/plan.md.')
    );
    expect(host.querySelector('h1')).toBeNull();

    mocks.read.mockResolvedValue(content('# Back again\n'));
    await act(async () => mocks.fileChanged?.());
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Back again'));
  });

  it('stops watching the file when the window closes', async () => {
    await mount();
    await vi.waitFor(() => expect(mocks.fileChanged).toBeDefined());
    await act(async () => root.unmount());
    expect(mocks.stopWatching).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });
});
