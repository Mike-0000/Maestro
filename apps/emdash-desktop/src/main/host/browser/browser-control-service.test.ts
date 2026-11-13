import { ok } from '@emdash/shared';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CANVAS_BROWSER_SETTINGS,
  type CanvasBrowserSettings,
} from '@core/features/canvas/contributions/settings';
import type { BrowserEvent } from '@core/primitives/browser/api';
import { BrowserControlService, CONTROL_LEASE_MS } from './browser-control-service';
import type { BrowserBindingListener } from './browser-webcontents-registry';

vi.mock('electron', () => ({}));

const ISOLATED = 'persist:emdash-browser-isolated-p1-w1-t1';
const PROFILE = 'persist:emdash-browser-profile';
const identity = { projectId: 'p1', workspaceId: 'w1', taskId: 't1' };

type Harness = ReturnType<typeof harness>;

function fakeContents(id: number) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    id,
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => 'http://localhost:5173/',
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off: vi.fn(),
    once: vi.fn(),
    fire(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function harness(settings: Partial<CanvasBrowserSettings> = {}) {
  let now = 1_000;
  const partitions = new Map<string, string>([
    ['b-iso', ISOLATED],
    ['b-profile', PROFILE],
    // Browser tabs in the task's own view: one on the task's isolated profile, one on the
    // developer's own profile.
    ['b-tab-iso', ISOLATED],
    ['b-tab-shared', PROFILE],
  ]);
  const shownAt = new Map<string, number>();
  const bound = new Map<string, ReturnType<typeof fakeContents>>();
  let bindingListener: BrowserBindingListener | null = null;
  const events: BrowserEvent[] = [];
  const automation = {
    observe: vi.fn(async () => ok({ url: 'http://localhost:5173/', title: 'App' })),
    act: vi.fn(async () =>
      ok({ url: 'http://localhost:5173/', title: 'App', changed: true as boolean })
    ),
    release: vi.fn(),
  };
  const consoleBuffer = {
    tail: vi.fn(() => []),
    attach: vi.fn(),
    detachWebContents: vi.fn(),
    forget: vi.fn(),
    push: vi.fn(),
  };
  const service = new BrowserControlService({
    registry: {
      getPartition: (id: string) => partitions.get(id) ?? null,
      getBoundWebContents: (id: string) => (bound.get(id) as unknown as WebContents) ?? null,
      getShownAt: (id: string) => shownAt.get(id) ?? 0,
      onBinding: (listener: BrowserBindingListener) => {
        bindingListener = listener;
        return () => {};
      },
    },
    automation: automation as never,
    consoleBuffer,
    emit: (event) => events.push(event),
    getSettings: async () => ({ ...DEFAULT_CANVAS_BROWSER_SETTINGS, ...settings }),
    listDevServerUrls: () => ['http://localhost:5173/'],
    reservedPorts: () => [40111],
    now: () => now,
  });
  function bind(browserId: string) {
    const contents = fakeContents(bound.size + 1);
    bound.set(browserId, contents);
    bindingListener?.({
      type: 'bound',
      browserId,
      webContents: contents as unknown as WebContents,
    });
    return contents;
  }
  return {
    service,
    automation,
    consoleBuffer,
    events,
    bind,
    unbind: (browserId: string) => bound.delete(browserId),
    /** The browser's surface came on screen now. */
    show: (browserId: string) => shownAt.set(browserId, now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const agent = { kind: 'agent' as const, conversationId: 'c1', name: 'Nova', ...identity };

describe('BrowserControlService', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness({ agentControl: true });
    h.bind('b-iso');
  });

  it('refuses to hand a shared-profile browser to agents', () => {
    const result = h.service.setControl({ browserId: 'b-profile', control: 'agents', ...identity });
    expect(result).toMatchObject({ success: false, error: { type: 'not-controllable' } });
  });

  it('denies automation until the user hands the browser to agents', async () => {
    const denied = await h.service.observe(
      { kind: 'conductor' },
      { browserId: 'b-iso', mode: 'text' }
    );
    expect(denied).toMatchObject({ success: false, error: { type: 'not-controllable' } });

    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    const allowed = await h.service.observe(
      { kind: 'conductor' },
      { browserId: 'b-iso', mode: 'text' }
    );
    expect(allowed.success).toBe(true);
  });

  it('scopes agents to their own task', async () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    const other = { ...agent, taskId: 't2' };
    const result = await h.service.act(other, {
      browserId: 'b-iso',
      action: { kind: 'reload' },
    });
    expect(result).toMatchObject({ success: false, error: { type: 'not-controllable' } });
    expect(h.automation.act).not.toHaveBeenCalled();
  });

  it('respects the per-actor settings switches', async () => {
    const off = harness({ agentControl: false, conductorControl: false });
    off.bind('b-iso');
    off.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    expect(
      await off.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } })
    ).toMatchObject({ success: false, error: { type: 'disabled' } });
    expect(
      await off.service.observe({ kind: 'conductor' }, { browserId: 'b-iso', mode: 'screenshot' })
    ).toMatchObject({ success: false, error: { type: 'disabled' } });
  });

  it('blocks navigation off the dev-server origin and to Maestro ports', async () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    const external = await h.service.act(agent, {
      browserId: 'b-iso',
      action: { kind: 'navigate', url: 'https://evil.example/' },
    });
    expect(external).toMatchObject({ success: false, error: { type: 'origin-denied' } });
    const reserved = await h.service.act(agent, {
      browserId: 'b-iso',
      action: { kind: 'navigate', url: 'http://127.0.0.1:40111/' },
    });
    expect(reserved).toMatchObject({ success: false, error: { type: 'origin-denied' } });
    const local = await h.service.act(agent, {
      browserId: 'b-iso',
      action: { kind: 'navigate', url: 'http://127.0.0.1:5173/login' },
    });
    expect(local.success).toBe(true);
  });

  it('gives the acting model a lease other actors must wait out', async () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    await h.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } });
    const leaseEvent = h.events.find((event) => event.type === 'automation');
    expect(leaseEvent).toMatchObject({ leaseUntil: 1_000 + CONTROL_LEASE_MS });

    const conductor = await h.service.act(
      { kind: 'conductor' },
      { browserId: 'b-iso', action: { kind: 'reload' } }
    );
    expect(conductor).toMatchObject({ success: false, error: { type: 'busy' } });

    h.advance(CONTROL_LEASE_MS + 1);
    const later = await h.service.act(
      { kind: 'conductor' },
      { browserId: 'b-iso', action: { kind: 'reload' } }
    );
    expect(later.success).toBe(true);
  });

  it('holds page-initiated navigations to the policy only while leased', async () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    const contents = h.bind('b-iso');
    const unleased = { url: 'https://example.com/', preventDefault: vi.fn() };
    contents.fire('will-navigate', unleased);
    expect(unleased.preventDefault).not.toHaveBeenCalled();

    await h.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } });
    const leased = { url: 'https://example.com/', preventDefault: vi.fn() };
    contents.fire('will-navigate', leased);
    expect(leased.preventDefault).toHaveBeenCalled();
    const redirect = { url: 'https://example.com/', isMainFrame: true, preventDefault: vi.fn() };
    contents.fire('will-redirect', redirect);
    expect(redirect.preventDefault).toHaveBeenCalled();

    h.service.stopLease('b-iso');
    const afterStop = { url: 'https://example.com/', preventDefault: vi.fn() };
    contents.fire('will-navigate', afterStop);
    expect(afterStop.preventDefault).not.toHaveBeenCalled();
  });

  it('rate limits bursts per actor', async () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    const results = [];
    for (let index = 0; index < 32; index += 1) {
      results.push(await h.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } }));
    }
    expect(results.at(-1)).toMatchObject({ success: false, error: { type: 'rate-limited' } });
  });

  it('releases the debugger when control goes back to the user', () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    h.service.setControl({ browserId: 'b-iso', control: 'user', ...identity });
    expect(h.automation.release).toHaveBeenCalled();
  });

  describe('while the user drives the tile', () => {
    beforeEach(() => {
      h.service.setControl({ browserId: 'b-iso', control: 'user', ...identity });
    });

    it('lets the task agent watch it (screenshot, outline) but not act', async () => {
      expect(h.service.findTaskBrowser('t1', 'observe')).toBe('b-iso');
      expect(h.service.findTaskBrowser('t1', 'control')).toBeNull();
      expect(h.service.describeTaskBrowser('t1')).toMatchObject({ control: 'user' });

      const shot = await h.service.observe(agent, { browserId: 'b-iso', mode: 'screenshot' });
      expect(shot.success).toBe(true);
      const outline = await h.service.observe(agent, { browserId: 'b-iso', mode: 'outline' });
      expect(outline.success).toBe(true);
      expect(h.automation.observe).toHaveBeenCalledTimes(2);

      const acted = await h.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } });
      expect(acted).toMatchObject({ success: false, error: { type: 'not-controllable' } });
      expect(h.automation.act).not.toHaveBeenCalled();
      // Watching shows up in the tile's activity line but never takes the lease.
      const activity = h.events.filter((event) => event.type === 'automation');
      expect(activity.length).toBeGreaterThan(0);
      expect(activity.some((event) => 'leaseUntil' in event || event.action === 'lease')).toBe(
        false
      );
    });

    it('keeps other tasks and the conductor out', async () => {
      const other = await h.service.observe(
        { ...agent, taskId: 't2' },
        { browserId: 'b-iso', mode: 'screenshot' }
      );
      expect(other).toMatchObject({ success: false, error: { type: 'not-controllable' } });
      const conductor = await h.service.observe(
        { kind: 'conductor' },
        { browserId: 'b-iso', mode: 'screenshot' }
      );
      expect(conductor).toMatchObject({ success: false, error: { type: 'not-controllable' } });
      expect(h.automation.observe).not.toHaveBeenCalled();
    });

    it('never offers a shared-profile tile to agents, even to watch', () => {
      expect(h.service.findTaskBrowser('t9', 'observe')).toBeNull();
    });
  });

  describe('the browser the developer is using for the task', () => {
    const tab = (browserId: string, control: 'user' | 'agents') => ({
      browserId,
      control,
      surface: 'task-view' as const,
      ...identity,
    });

    beforeEach(() => {
      // An agent tile on the canvas, alive but off screen: the developer is not on that canvas.
      h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    });

    it('is the one shown last: the task view tab while the developer works there', () => {
      h.service.setControl(tab('b-tab-iso', 'agents'));
      h.bind('b-tab-iso');
      h.advance(10);
      h.show('b-tab-iso');

      expect(h.service.findTaskBrowser('t1', 'control')).toBe('b-tab-iso');
      expect(h.service.findTaskBrowser('t1', 'observe')).toBe('b-tab-iso');
      expect(h.service.describeTaskBrowser('t1')).toMatchObject({
        browserId: 'b-tab-iso',
        surface: 'task-view',
        isolated: true,
        live: true,
      });

      h.advance(10);
      h.show('b-iso');
      expect(h.service.findTaskBrowser('t1', 'control')).toBe('b-iso');
      expect(h.service.describeTaskBrowser('t1')).toMatchObject({ surface: 'canvas' });
    });

    it('is not swapped for a hidden agent tile while the developer drives the tab', () => {
      h.service.setControl(tab('b-tab-iso', 'user'));
      h.bind('b-tab-iso');
      h.advance(10);
      h.show('b-tab-iso');

      // Acting asks the developer to hand this tab over instead of driving the hidden tile.
      expect(h.service.findTaskBrowser('t1', 'control')).toBeNull();
      expect(h.service.findTaskBrowser('t1', 'observe')).toBe('b-tab-iso');
    });

    it("never reads a tab on the developer's own profile, and says which browser it is", async () => {
      expect(h.service.setControl(tab('b-tab-shared', 'user')).success).toBe(true);
      h.bind('b-tab-shared');
      h.advance(10);
      h.show('b-tab-shared');

      expect(h.service.findTaskBrowser('t1', 'observe')).toBeNull();
      expect(h.service.findTaskBrowser('t1', 'control')).toBeNull();
      expect(h.service.describeTaskBrowser('t1')).toEqual(
        expect.objectContaining({ surface: 'task-view', isolated: false, url: null })
      );
      expect(h.service.setControl(tab('b-tab-shared', 'agents')).success).toBe(false);
      const read = await h.service.observe(agent, { browserId: 'b-tab-shared', mode: 'text' });
      expect(read).toMatchObject({ success: false, error: { type: 'not-controllable' } });
      expect(h.automation.observe).not.toHaveBeenCalled();
    });

    it('falls back to a live surface once the shown one has no page (its view closed)', () => {
      h.service.setControl(tab('b-tab-iso', 'agents'));
      h.bind('b-tab-iso');
      h.advance(10);
      h.show('b-tab-iso');
      h.unbind('b-tab-iso');

      expect(h.service.findTaskBrowser('t1', 'control')).toBe('b-iso');
    });

    it('asks the renderer for that browser when acting needs it handed over', async () => {
      h.service.setControl(tab('b-tab-shared', 'user'));
      h.bind('b-tab-shared');
      h.advance(10);
      h.show('b-tab-shared');

      void h.service.requestOpen(agent, null, 'control');
      await Promise.resolve();
      await Promise.resolve();
      expect(h.events.find((event) => event.type === 'open-request')).toMatchObject({
        browserId: 'b-tab-shared',
        access: 'control',
      });
    });

    it('forgets a closed tab', () => {
      h.service.setControl(tab('b-tab-iso', 'agents'));
      h.bind('b-tab-iso');
      h.advance(10);
      h.show('b-tab-iso');
      h.service.forget('b-tab-iso');

      expect(h.service.findTaskBrowser('t1', 'control')).toBe('b-iso');
    });
  });

  it('lets an agent watch while another actor holds the lease', async () => {
    h.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
    await h.service.act({ kind: 'conductor' }, { browserId: 'b-iso', action: { kind: 'reload' } });
    const shot = await h.service.observe(agent, { browserId: 'b-iso', mode: 'screenshot' });
    expect(shot.success).toBe(true);
    const acted = await h.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } });
    expect(acted).toMatchObject({ success: false, error: { type: 'busy' } });
  });

  it('round-trips open requests through the renderer', async () => {
    const pending = h.service.requestOpen(agent, 'http://localhost:5173/');
    await Promise.resolve();
    await Promise.resolve();
    const request = h.events.find((event) => event.type === 'open-request');
    expect(request).toMatchObject({
      taskId: 't1',
      url: 'http://localhost:5173/',
      access: 'control',
    });
    if (request?.type !== 'open-request') throw new Error('no request');
    h.service.ackOpenRequest(request.requestId, 'b-iso');
    expect(await pending).toEqual({ success: true, data: 'b-iso' });
  });

  describe('opening an empty tile (no dev server yet)', () => {
    async function openUnbound(fresh: Harness) {
      const pending = fresh.service.requestOpen(agent, null, 'control');
      await vi.advanceTimersByTimeAsync(0);
      const request = fresh.events.find((event) => event.type === 'open-request');
      if (request?.type !== 'open-request') throw new Error('no request');
      // The renderer created the tile and handed it to agents; its webview is not attached yet.
      fresh.service.setControl({ browserId: 'b-iso', control: 'agents', ...identity });
      fresh.service.ackOpenRequest(request.requestId, 'b-iso');
      return pending;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports the tile open only once its webview attaches, then observes it', async () => {
      const fresh = harness({ agentControl: true });
      const pending = openUnbound(fresh);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);

      fresh.bind('b-iso');
      expect(await pending).toEqual({ success: true, data: 'b-iso' });
      const look = await fresh.service.observe(agent, { browserId: 'b-iso', mode: 'text' });
      expect(look.success).toBe(true);
      expect(fresh.automation.observe).toHaveBeenCalledTimes(1);
    });

    it('does not claim agents can use a tile whose page never comes up', async () => {
      const fresh = harness({ agentControl: true });
      const pending = openUnbound(fresh);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result).toMatchObject({ success: false, error: { type: 'not-bound' } });
      if (result.success) throw new Error('expected not-bound');
      expect(result.error.message).toMatch(/did not come up/);
      expect(result.error.message).toMatch(/open_app/);
    });
  });

  it.each([
    ['declined', 'not-controllable', /kept control/],
    ['consent-pending', 'not-controllable', /waiting for an answer/],
    ['disabled', 'disabled', /turned off/],
  ] as const)('explains a %s open request', async (denial, type, message) => {
    const pending = h.service.requestOpen(agent, null, 'control');
    await Promise.resolve();
    await Promise.resolve();
    const request = h.events.find((event) => event.type === 'open-request');
    if (request?.type !== 'open-request') throw new Error('no request');
    h.service.ackOpenRequest(request.requestId, null, denial);
    const result = await pending;
    expect(result).toMatchObject({ success: false, error: { type } });
    if (result.success) throw new Error('expected a denial');
    expect(result.error.message).toMatch(message);
  });

  it('refuses open requests off the task origin before asking the renderer', async () => {
    const result = await h.service.requestOpen(agent, 'https://evil.example/');
    expect(result).toMatchObject({ success: false, error: { type: 'origin-denied' } });
    expect(h.events.some((event) => event.type === 'open-request')).toBe(false);
  });

  describe('public websites', () => {
    const control = {
      browserId: 'b-iso',
      control: 'agents' as const,
      publicOrigins: ['https://example.com'],
      ...identity,
    };
    const navigate = (url: string) => ({
      browserId: 'b-iso',
      action: { kind: 'navigate' as const, url },
    });

    it('lets the conductor load an approved public origin when the setting is on', async () => {
      const on = harness({ conductorPublicWeb: true });
      on.bind('b-iso');
      on.service.setControl(control);
      const result = await on.service.act({ kind: 'conductor' }, navigate('https://example.com/a'));
      expect(result.success).toBe(true);
      expect(on.automation.act).toHaveBeenCalledTimes(1);
    });

    it('denies unapproved, insecure and private targets', async () => {
      const on = harness({ conductorPublicWeb: true });
      on.bind('b-iso');
      on.service.setControl({
        ...control,
        publicOrigins: ['https://example.com', 'https://192.168.1.1', 'http://plain.example.com'],
      });
      for (const url of [
        'https://other.example.org/',
        'http://example.com/',
        'https://192.168.1.1/',
        'http://plain.example.com/',
        'http://169.254.169.254/latest/meta-data/',
      ]) {
        const result = await on.service.act({ kind: 'conductor' }, navigate(url));
        expect(result, url).toMatchObject({
          success: false,
          error: { type: 'origin-denied', url },
        });
      }
      expect(on.automation.act).not.toHaveBeenCalled();
      expect(on.events).toContainEqual(
        expect.objectContaining({ type: 'automation', action: 'navigate', detail: 'blocked' })
      );
    });

    it('denies approved origins while the setting is off', async () => {
      h.service.setControl(control);
      const result = await h.service.act({ kind: 'conductor' }, navigate('https://example.com/'));
      expect(result).toMatchObject({ success: false, error: { type: 'origin-denied' } });
      if (!result.success) expect(result.error.message).toContain('turned off');
      expect(h.automation.act).not.toHaveBeenCalled();
    });

    it('never extends the approval to coding agents', async () => {
      const on = harness({ conductorPublicWeb: true });
      on.bind('b-iso');
      on.service.setControl(control);
      const result = await on.service.act(agent, navigate('https://example.com/'));
      expect(result).toMatchObject({ success: false, error: { type: 'origin-denied' } });
      expect(await on.service.requestOpen(agent, 'https://example.com/')).toMatchObject({
        success: false,
        error: { type: 'origin-denied' },
      });
      expect(on.service.describeTaskBrowser('t1')?.allowedOrigins).not.toContain(
        'https://example.com'
      );
    });

    it('holds page-initiated navigation to approved origins during a conductor lease', async () => {
      const on = harness({ conductorPublicWeb: true });
      const contents = on.bind('b-iso');
      on.service.setControl(control);
      await on.service.act({ kind: 'conductor' }, navigate('https://example.com/'));

      const within = { preventDefault: vi.fn(), url: 'https://example.com/next' };
      contents.fire('will-navigate', within);
      expect(within.preventDefault).not.toHaveBeenCalled();

      const away = { preventDefault: vi.fn(), url: 'https://tracker.example.net/' };
      contents.fire('will-navigate', away);
      expect(away.preventDefault).toHaveBeenCalled();
      const redirect = {
        preventDefault: vi.fn(),
        url: 'http://10.0.0.1/admin',
        isMainFrame: true,
      };
      contents.fire('will-redirect', redirect);
      expect(redirect.preventDefault).toHaveBeenCalled();
      expect(on.consoleBuffer.push).toHaveBeenCalledTimes(2);
    });

    it('holds an agent lease to the task origins even on a tile with approvals', async () => {
      const on = harness({ conductorPublicWeb: true });
      const contents = on.bind('b-iso');
      on.service.setControl(control);
      await on.service.act(agent, { browserId: 'b-iso', action: { kind: 'reload' } });
      const event = { preventDefault: vi.fn(), url: 'https://example.com/' };
      contents.fire('will-navigate', event);
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });
});
