import { WireError, type Controller, type LiveSource } from '@emdash/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import {
  createOwnerDesktopFilter,
  hostServedDesktopPath,
  hostServedDesktopTopic,
} from './owner-desktop-filter';

function recordingDesktop() {
  const source: LiveSource = {
    snapshot: () => ({ revision: 1, data: 'ok' }) as never,
    subscribe: () => () => {},
  };
  const controller: Controller = {
    call: vi.fn(async (path: string) => `called ${path}`),
    resolveLive: vi.fn(() => source),
    acquireLive: vi.fn(() => ({ ready: async () => source, release: async () => {} })),
  };
  return controller;
}

describe('owner desktop filter', () => {
  it('maps host-served owner paths onto the desktop controller', () => {
    expect(hostServedDesktopPath('desktop.tasks.createTask')).toBe('tasks.createTask');
    expect(hostServedDesktopPath('desktop.host.getPlatform')).toBe('host.getPlatform');
    expect(hostServedDesktopPath('desktop.host.persistDroppedBlob')).toBe(
      'host.persistDroppedBlob'
    );
    expect(hostServedDesktopTopic('desktop.tasks.taskList.list|{"projectId":"p"}')).toBe(
      'tasks.taskList.list|{"projectId":"p"}'
    );
  });

  it('refuses client-side endpoints and malformed paths', () => {
    for (const path of [
      'desktop.host.openExternal',
      'desktop.host.events',
      'desktop.host.getPlatformX',
      'desktop.browser.registerSession',
      'desktop.updates.download',
      'desktop.logging.write',
      'desktop.devPerf.status',
      'desktop.nope.call',
      'desktop.__proto__.x',
      'desktop.constructor.x',
      'desktop.tasks',
      'desktop.tasks.',
      'desktop..x',
      'tasks.createTask',
      'session.attach',
    ]) {
      expect(hostServedDesktopPath(path), path).toBeUndefined();
    }
    expect(hostServedDesktopTopic('desktop.browser.state|1')).toBeUndefined();
  });

  it('delegates allowed calls and answers NOT_FOUND for the rest', async () => {
    const desktop = recordingDesktop();
    const filter = createOwnerDesktopFilter(desktop);

    await expect(filter.call('desktop.host.getPlatform', undefined)).resolves.toBe(
      'called host.getPlatform'
    );
    const refused = await filter.call('desktop.host.openExternal', 'https://x').catch((e) => e);
    expect(refused).toBeInstanceOf(WireError);
    expect((refused as WireError).code).toBe('NOT_FOUND');
    expect(desktop.call).toHaveBeenCalledTimes(1);
  });

  it('delegates allowed live topics and refuses the rest without touching the desktop', async () => {
    const desktop = recordingDesktop();
    const filter = createOwnerDesktopFilter(desktop);

    const lease = filter.acquireLive('desktop.tasks.taskList.list|{"projectId":"p"}');
    await expect(lease?.ready()).resolves.toBeDefined();
    expect(desktop.acquireLive).toHaveBeenCalledWith('tasks.taskList.list|{"projectId":"p"}');

    const refused = filter.acquireLive('desktop.browser.state');
    const error = await refused?.ready().catch((e: unknown) => e);
    expect((error as WireError).code).toBe('NOT_FOUND');
    expect(() => filter.resolveLive('desktop.browser.state')?.snapshot()).toThrow(WireError);
    expect(desktop.acquireLive).toHaveBeenCalledTimes(1);
    expect(desktop.resolveLive).not.toHaveBeenCalled();
  });
});
