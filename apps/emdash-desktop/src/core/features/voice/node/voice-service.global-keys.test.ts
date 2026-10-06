import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { DEFAULT_VOICE_SETTINGS } from '../api/contract';
import { HOLD_DELAY_MS, type HoldOutput } from '../api/hold-to-talk';
import { VoiceService } from './voice-service';

type KeyEvent = { type: 'down' | 'up'; keycode: number };

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(stored: Record<string, unknown> = {}, taken: readonly string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'chorus-keys-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'voice-settings.json'),
    JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, ...stored })
  );
  const registered = new Map<string, () => void>();
  let hookListener: ((event: KeyEvent) => void) | null = null;
  const host = {
    dataDir: dir,
    secrets: { getSecret: async () => null },
    globalShortcuts: {
      register: vi.fn((accelerator: string, onPress: () => void) => {
        if (taken.includes(accelerator)) return false;
        registered.set(accelerator, onPress);
        return true;
      }),
      unregister: vi.fn((accelerator: string) => void registered.delete(accelerator)),
    },
    keyboardHook: {
      start: vi.fn((onKey: (event: KeyEvent) => void) => {
        hookListener = onKey;
        return true;
      }),
      stop: vi.fn(() => {
        hookListener = null;
      }),
    },
  } as unknown as ChorusHostServices;
  const onToggle = vi.fn();
  const holds: HoldOutput[] = [];
  const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
  const service = new VoiceService(host, onToggle, logger, (output) => holds.push(output));
  await service.start();
  return {
    service,
    host,
    registered,
    onToggle,
    holds,
    press: (event: KeyEvent) => hookListener?.(event),
    hookRunning: () => hookListener !== null,
    stored: async () =>
      JSON.parse(await readFile(join(dir, 'voice-settings.json'), 'utf8')) as Record<
        string,
        unknown
      >,
  };
}

describe('VoiceService global toggle shortcut', () => {
  it('registers a recorded Num Lock shortcut, stores it, and drops the old one', async () => {
    const { service, registered, onToggle, stored } = await setup();
    expect([...registered.keys()]).toEqual(['Control+Alt+Space']);

    const status = await service.updateSettings({ globalShortcut: 'Numlock' });
    expect(status.globalShortcutRegistered).toBe(true);
    expect([...registered.keys()]).toEqual(['Numlock']);
    expect((await stored()).globalShortcut).toBe('Numlock');

    registered.get('Numlock')?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
    service.dispose();
    expect(registered.size).toBe(0);
  });

  it('reports a shortcut the OS refuses and unregisters when cleared', async () => {
    const { service, registered } = await setup({}, ['Numlock']);
    expect(
      (await service.updateSettings({ globalShortcut: 'Numlock' })).globalShortcutRegistered
    ).toBe(false);
    expect(registered.size).toBe(0);
    expect((await service.updateSettings({ globalShortcut: '' })).globalShortcutRegistered).toBe(
      false
    );
    service.dispose();
  });
});

describe('VoiceService global hold-to-talk key', () => {
  it('watches a recorded Num Lock key through the system hook', async () => {
    const { service, press, holds, hookRunning, stored } = await setup();
    expect(hookRunning()).toBe(false);

    const status = await service.updateSettings({ globalHoldKey: 'NumLock' });
    expect(status.globalHoldActive).toBe(true);
    expect((await stored()).globalHoldKey).toBe('NumLock');

    vi.useFakeTimers();
    press({ type: 'down', keycode: 69 });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    press({ type: 'up', keycode: 69 });
    expect(holds).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
    vi.useRealTimers();

    expect((await service.updateSettings({ globalHoldKey: 'off' })).globalHoldActive).toBe(false);
    expect(hookRunning()).toBe(false);
    service.dispose();
  });

  it('watches a chord and keeps working with a value from the old fixed list', async () => {
    const { service, press, holds } = await setup({ globalHoldKey: 'right-ctrl' });
    expect((await service.status()).globalHoldActive).toBe(true);

    vi.useFakeTimers();
    press({ type: 'down', keycode: 3613 });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    press({ type: 'up', keycode: 3613 });
    expect(holds).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
    vi.useRealTimers();

    holds.length = 0;
    await service.updateSettings({ globalHoldKey: 'ControlLeft+F13' });
    vi.useFakeTimers();
    press({ type: 'down', keycode: 91 });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 2);
    expect(holds).toEqual([]);
    press({ type: 'down', keycode: 29 });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(holds).toEqual([{ type: 'start', intent: 'command' }]);
    service.dispose();
  });

  it('does not start the hook for a key it cannot watch', async () => {
    const { service, hookRunning } = await setup({ globalHoldKey: 'MediaPlayPause' });
    expect(hookRunning()).toBe(false);
    expect((await service.status()).globalHoldActive).toBe(false);
    service.dispose();
  });
});
