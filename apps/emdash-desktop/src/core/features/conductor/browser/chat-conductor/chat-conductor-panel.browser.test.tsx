import '@emdash/ui/style.css';
import { makeAutoObservable } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ChatDigest } from '../../api/chat-conductor/digest';
import type { ConductorImage } from '../../api/chat-conductor/images';
import type { ChatConductorEntry, ChatConductorStatus } from '../../api/chat-conductor/thread';
import { ChatConductorPanel, type ChatConductorPanelProps } from './chat-conductor-panel';
import type { ChatConductorSession } from './session';
import { finishTask } from './view/finish-task';
import { StatusStrip } from './view/status-strip';

const fixture = vi.hoisted(() => ({
  canvas: { agentEntries: [] as unknown[] },
  navigated: [] as unknown[],
}));

vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasStore: () => fixture.canvas,
}));
vi.mock('../roster', () => ({
  entryForConversation: (canvas: { agentEntries: { conversationId: string }[] }, id: string) =>
    canvas.agentEntries.find((entry) => entry.conversationId === id),
}));
vi.mock('@core/primitives/navigation/browser/navigation-selectors', () => ({
  getNavigation: () => ({ navigate: (ref: unknown) => fixture.navigated.push(ref) }),
}));
vi.mock('@core/features/settings/contributions/views', () => ({
  settingsViewDef: (params: unknown) => ({ view: 'settings', params }),
}));
vi.mock('@core/primitives/external-links/browser', () => ({
  useMarkdownLinkOpener: () => () => {},
}));
vi.mock('../hud/hud-clearance', () => ({ useHudClearance: () => 0 }));
vi.mock('@core/features/conversations/api/browser/conversation-title-utils', () => ({
  formatConversationTitleForDisplay: (_provider: string, title: string | undefined) =>
    title ?? 'Chat',
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** A 1×1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function pngFile(name: string): File {
  const bytes = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
  return new File([bytes], name, { type: 'image/png' });
}

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1_000).toISOString();

const digest: ChatDigest = {
  outcome: 'finished',
  headline: 'Hang-up: ready to try, not merged.',
  did: ['Rebuilt Katana Dev with `fix/hang-up`.'],
  status: 'Tests pass; not tried on a real call.',
  next: 'Try it, then say "merge it".',
  asked: 'Make hanging up fast.',
  where: 'Branch `fix/hang-up`, not merged.',
  move: 'Call Katana Dev and say goodbye.',
  appUrl: 'http://localhost:5173/',
};

const thread: ChatConductorEntry[] = [
  { kind: 'developer', id: 'd1', at: ago(600), text: 'Can we try the hang-up?' },
  {
    kind: 'action',
    id: 'a1',
    at: ago(590),
    tool: 'send_to_agent',
    summary: 'Sent the brief',
    status: 'done',
  },
  {
    kind: 'action',
    id: 'a2',
    at: ago(580),
    tool: 'send_to_agent',
    summary: 'Sent a follow-up',
    status: 'failed',
    detail: 'The agent did not take the prompt.',
  },
  { kind: 'conductor', id: 'c1', at: ago(500), text: 'The steps:\n\n1. Build\n2. Restart' },
  { kind: 'event', id: 'e1', at: ago(400), text: 'Atlas finished a turn' },
  { kind: 'digest', id: 'g1', at: ago(361), digest, askedAt: ago(600) },
  {
    kind: 'conductor',
    id: 'c2',
    at: ago(360),
    text: 'Hang-up is ready to try. Want the app open?',
  },
];

class FakeSession {
  entries: ChatConductorEntry[] = [];
  status: ChatConductorStatus | null = null;
  busy = false;
  activity: string | null = null;
  loaded = true;
  draft = '';
  autonomy = true;
  chatIds = ['c1'];
  sent: string[] = [];
  stops = 0;
  constructor(init: Partial<FakeSession>) {
    Object.assign(this, init);
    makeAutoObservable(this);
  }
  images: ConductorImage[] = [];
  sentImages: string[][] = [];
  send(text: string, images: readonly ConductorImage[] = []) {
    this.sent.push(text);
    if (images.length > 0) this.sentImages.push(images.map((image) => image.name));
  }
  setDraft(text: string) {
    this.draft = text;
  }
  addImages(images: ConductorImage[]) {
    this.images = [...this.images, ...images];
  }
  removeImage(id: string) {
    this.images = this.images.filter((image) => image.id !== id);
  }
  clearImages() {
    this.images = [];
  }
  setAutonomy(on: boolean) {
    this.autonomy = on;
    if (!on) this.yolo = false;
  }
  yolo = false;
  setYolo(on: boolean) {
    this.yolo = on;
    if (on) this.autonomy = true;
  }
  catchUp() {}
  stop() {
    this.stops += 1;
  }
  async reset() {}
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(
  session: FakeSession,
  props: Partial<Omit<ChatConductorPanelProps, 'session'>> = {}
): { calls: string[]; host: HTMLDivElement } {
  const calls: string[] = [];
  host = document.createElement('div');
  host.style.width = '900px';
  host.style.height = '700px';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ChatConductorPanel
        session={session as unknown as ChatConductorSession}
        ready
        enabled
        autoFocus={false}
        onShowRaw={() => calls.push('raw')}
        onDone={() => {
          calls.push('done');
        }}
        onMerge={() => calls.push('merge')}
        onOpenApp={(url) => calls.push(`open ${url}`)}
        devServerOrigins={['http://localhost:5173']}
        providerLabel="Claude"
        accountLabel="work account"
        conductorEffort="medium"
        {...props}
      />
    )
  );
  return { calls, host };
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );

describe('ChatConductorPanel', () => {
  it('draws every kind of entry in a polite live thread, the newest line large', () => {
    const { host } = mount(
      new FakeSession({ entries: thread, status: { state: 'done', headline: 'Ready' } })
    );
    const live = host.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toBeTruthy();
    expect(live.textContent).toContain('Can we try the hang-up?');
    expect(live.textContent).toContain('Worked');
    expect(live.querySelector('ol')?.textContent).toContain('Restart');
    expect(live.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe(
      'Atlas finished a turn'
    );
    const report = live.querySelector('article') as HTMLElement;
    expect(report.getAttribute('aria-label')).toBe('Report: Hang-up: ready to try, not merged.');
    expect(report.textContent).toContain('Your move');
    expect(report.querySelector('code')?.textContent).toBe('fix/hang-up');
    const latest = [...live.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('Want the app open?')
    );
    expect(latest?.className).toContain('text-xl');
  });

  it('opens the work by itself when a step failed, and folds it on request', async () => {
    const { host } = mount(new FakeSession({ entries: thread }));
    const toggle = [...host.querySelectorAll('button[aria-expanded]')].find((candidate) =>
      candidate.textContent?.startsWith('Worked')
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('1 failed');
    const steps = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(steps?.textContent).toContain('Sent a follow-up');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Sent a follow-up');
  });

  it('opens the work when a later step of a live turn fails, and stays closed once folded', async () => {
    const [developer, done, failed] = thread as [
      ChatConductorEntry,
      ChatConductorEntry,
      ChatConductorEntry,
    ];
    const session = new FakeSession({ entries: [developer, done], busy: true });
    const { host } = mount(session);
    const toggle = () =>
      [...host.querySelectorAll('button[aria-expanded]')].find((candidate) =>
        candidate.textContent?.startsWith('Worked')
      ) as HTMLButtonElement;
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    act(() => {
      session.entries = [developer, done, failed];
    });
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Sent a follow-up');

    await userEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    act(() => {
      session.entries = [
        developer,
        done,
        failed,
        { ...(failed as Extract<ChatConductorEntry, { kind: 'action' }>), id: 'a3' },
      ];
    });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the report age out of what the live region reads, with a fixed time instead', () => {
    const { host } = mount(new FakeSession({ entries: thread }));
    const live = host.querySelector('[aria-live="polite"]') as HTMLElement;
    const age = [...live.querySelectorAll('span')].find((span) =>
      span.textContent?.includes('ago')
    );
    expect(age?.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(live.querySelector('.sr-only')?.textContent).toContain(
      new Date(ago(600)).toLocaleString()
    );
  });

  it('disables Done while the archive runs, and on failure says so without leaving', async () => {
    fixture.navigated.length = 0;
    let fail: (error: Error) => void = () => {};
    const archive = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
    );
    const failures: unknown[] = [];
    const { host } = mount(new FakeSession({ entries: thread }), {
      onDone: () => finishTask(archive, (error) => failures.push(error)),
    });
    const done = button(host, 'Done')!;
    await userEvent.click(done);
    expect(done.disabled).toBe(true);
    done.click();
    expect(archive).toHaveBeenCalledTimes(1);

    await act(async () => fail(new Error('project offline')));
    expect(failures).toHaveLength(1);
    expect(fixture.navigated).toEqual([]);
    expect(done.disabled).toBe(false);
  });

  it('enables Done again after a successful archive and reports no failure', async () => {
    const archive = vi.fn(async () => {});
    const failures: unknown[] = [];
    const { host } = mount(new FakeSession({ entries: thread }), {
      onDone: () => finishTask(archive, (error) => failures.push(error)),
    });
    const done = button(host, 'Done')!;
    await act(async () => userEvent.click(done));
    expect(archive).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
    expect(done.disabled).toBe(false);
  });

  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const session = new FakeSession({ entries: thread });
    const { host } = mount(session);
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    await userEvent.click(field);
    await userEvent.keyboard('Keep it');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(session.sent).toEqual([]);
    expect(session.draft).toBe('Keep it\n');
    await userEvent.keyboard('{Enter}');
    expect(session.sent).toEqual(['Keep it\n']);
    expect(session.draft).toBe('');
  });

  it("offers the current report's actions and calls back", async () => {
    const { host, calls } = mount(new FakeSession({ entries: thread }));
    await userEvent.click(button(host, 'Done')!);
    await userEvent.click(button(host, 'Merge…')!);
    await userEvent.click(button(host, 'Open app')!);
    await userEvent.click(button(host, 'Show raw')!);
    expect(calls).toEqual(['done', 'merge', 'open http://localhost:5173/', 'raw']);
  });

  it('leaves out Merge when the task cannot be integrated, and refuses a public address', () => {
    const entries = thread.map((entry) =>
      entry.kind === 'digest'
        ? { ...entry, digest: { ...digest, appUrl: 'https://example.com/' } }
        : entry
    );
    const { host } = mount(new FakeSession({ entries }), { onMerge: null });
    expect(button(host, 'Merge…')).toBeUndefined();
    expect(button(host, 'Open app')?.disabled).toBe(true);
  });

  it('draws an earlier report as a card without its actions once the developer moved on', () => {
    const entries: ChatConductorEntry[] = [
      ...thread,
      { kind: 'developer', id: 'd2', at: ago(10), text: 'Thanks.' },
    ];
    const { host } = mount(new FakeSession({ entries }));
    const report = host.querySelector('article') as HTMLElement;
    expect(report.className).toContain('border');
    expect(button(host, 'Done')).toBeUndefined();
    expect(button(host, 'Show raw')).toBeUndefined();
    expect(button(host, 'Open app')).toBeTruthy();
  });

  it('shows the state and the facts it knows in the footer, and stops a running turn', async () => {
    const session = new FakeSession({
      entries: thread,
      busy: true,
      activity: 'Reading the chat…',
    });
    const { host } = mount(session);
    expect(host.textContent).toContain('Working · 0s · Reading the chat…');
    expect(host.textContent).toContain('Claude · work account · conductor on medium effort');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe(
      'Write to the conductor. It is sent when this turn ends.'
    );
    await userEvent.click(button(host, 'Stop')!);
    expect(session.stops).toBe(1);
  });

  it('invites a first message in an empty thread', () => {
    const { host } = mount(new FakeSession({}));
    expect(host.querySelector('h2')?.textContent).toBe('Nothing here yet');
    expect(host.textContent).toContain('Idle');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe(
      'Tell the conductor what you want from this task'
    );
  });

  it('shows the setup screen when the conductor cannot run and nothing is in the thread', () => {
    const { host } = mount(new FakeSession({}), { ready: false });
    expect(host.querySelector('h2')?.textContent).toBe('The conductor needs an API key');
    expect(host.querySelector('textarea')).toBeNull();
    expect(button(host, 'Open settings')).toBeTruthy();
  });

  it('keeps the thread readable with the composer off when the conductor cannot run', () => {
    const { host } = mount(new FakeSession({ entries: thread }), { ready: false });
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);
    expect(field.placeholder).toBe('The conductor is off');
    expect(host.textContent).toContain('The conductor has no API key');
    expect(button(host, 'Open settings')).toBeTruthy();
  });

  it('shows a spinner while the thread is read', () => {
    const { host } = mount(new FakeSession({ loaded: false }));
    expect(host.querySelector('[aria-label="Loading the thread"]')).toBeTruthy();
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('takes an image pasted from the clipboard and sends it with the message', async () => {
    const session = new FakeSession({ entries: thread });
    const { host } = mount(session);
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    const clipboard = new DataTransfer();
    clipboard.items.add(pngFile('image.png'));
    act(() => {
      field.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
      );
    });
    await expect.poll(() => session.images.length).toBe(1);
    expect(session.images[0]).toMatchObject({ name: 'image.png', mediaType: 'image/png' });
    expect(session.images[0]!.data).toBe(PNG_BASE64);
    expect(host.querySelector('img[alt="image.png"]')).toBeTruthy();

    // An image alone is enough to send.
    await userEvent.click(host.querySelector('button[aria-label="Send"]') as HTMLButtonElement);
    expect(session.sentImages).toEqual([['image.png']]);
    expect(session.images).toEqual([]);
  });

  it('takes an image file dropped from the desktop, and refuses what is not an image', async () => {
    const session = new FakeSession({ entries: thread });
    const { host } = mount(session);
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    const drag = new DataTransfer();
    drag.items.add(pngFile('shot.png'));
    drag.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    act(() => {
      for (const type of ['dragenter', 'dragover', 'drop']) {
        field.dispatchEvent(
          new DragEvent(type, { dataTransfer: drag, bubbles: true, cancelable: true })
        );
      }
    });
    await expect.poll(() => session.images.map((image) => image.name)).toEqual(['shot.png']);
    await expect
      .poll(() => host.querySelector('[role="status"]')?.textContent)
      .toContain('notes.txt is not a PNG, JPEG, GIF or WebP image.');
    await userEvent.click(
      host.querySelector('button[aria-label="Remove shot.png"]') as HTMLButtonElement
    );
    expect(session.images).toEqual([]);
  });
});

describe('StatusStrip', () => {
  it('names the state and has no view switch of its own', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <StatusStrip glyph="needs_you" headline="Migration: keep or drop the old one?" needsYou />
      )
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Migration: keep or drop the old one?'
    );
    // The conductor and the raw chats are tabs of the task's strip now, not a switch here.
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('switches YOLO mode under the composer, which turns acting for the developer on', async () => {
    const session = new FakeSession({ autonomy: false });
    const { host } = mount(session);
    const yolo = host.querySelector('[aria-label="YOLO"]') as HTMLElement;
    const acting = host.querySelector('[aria-label="Act on my behalf"]') as HTMLElement;
    expect(yolo.getAttribute('aria-checked')).toBe('false');

    await userEvent.click(yolo);
    expect(session.yolo).toBe(true);
    expect(session.autonomy).toBe(true);
    await vi.waitFor(() => expect(yolo.getAttribute('aria-checked')).toBe('true'));
    expect(acting.getAttribute('aria-checked')).toBe('true');

    await userEvent.click(acting);
    expect(session.autonomy).toBe(false);
    expect(session.yolo).toBe(false);
  });
});
