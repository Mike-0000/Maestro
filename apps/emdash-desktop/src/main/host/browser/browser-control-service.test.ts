import { ok } from '@emdash/shared';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  ]);
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

  it('blocks navigation off the dev-server origin and to Chorus ports', async () => {
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

  it('round-trips open requests through the renderer', async () => {
    const pending = h.service.requestOpen(agent, 'http://localhost:5173/');
    await Promise.resolve();
    await Promise.resolve();
    const request = h.events.find((event) => event.type === 'open-request');
    expect(request).toMatchObject({ taskId: 't1', url: 'http://localhost:5173/' });
    if (request?.type !== 'open-request') throw new Error('no request');
    h.service.ackOpenRequest(request.requestId, 'b-iso');
    expect(await pending).toEqual({ success: true, data: 'b-iso' });
  });
});
