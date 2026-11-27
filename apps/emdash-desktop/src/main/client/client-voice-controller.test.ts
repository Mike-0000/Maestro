import { noopLogger } from '@emdash/shared/logger';
import { createEventStreamHost } from '@emdash/wire/live';
import { client, connect, createController, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_SETTINGS,
  voiceContract,
  type VoiceEvent,
  type VoiceSettings,
  type VoiceStatus,
} from '@core/features/voice/api';
import type { GlobalVoiceKeyPorts } from '@core/features/voice/node/global-voice-keys';
import type { VoiceFocusGate } from '@core/features/voice/node/voice-focus';
import {
  chorusCredentialIds,
  type ChorusCredentialId,
} from '@core/primitives/chorus-host/api/credentials';
import { createClientVoiceController } from './client-controllers';

type KeyEvent = { type: 'down' | 'up'; keycode: number };

const lifetimes: AbortController[] = [];
afterEach(() => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
});

/** A host voice domain: stored settings, its own key status, and an event feed. */
function fakeHost(stored: Partial<VoiceSettings> = {}) {
  let settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...stored };
  const events = createEventStreamHost(voiceContract.events);
  const status = (): VoiceStatus => ({
    settings,
    credentials: Object.fromEntries(chorusCredentialIds.map((id) => [id, false])) as Record<
      ChorusCredentialId,
      boolean
    >,
    // The host's own registration, which the client must not report as its own.
    globalShortcutRegistered: false,
    globalHoldActive: false,
  });
  const unused = () => Promise.reject(new Error('not used in this test'));
  const controller = createController(voiceContract, {
    transcribe: unused,
    getStatus: async () => status(),
    openStream: unused,
    pushAudio: unused,
    closeStream: unused,
    abortStream: unused,
    getDictationModel: unused,
    downloadDictationModel: unused,
    openDictation: unused,
    warmDictation: unused,
    closeDictation: unused,
    startTts: async () => {},
    stopTts: unused,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return status();
    },
    setCredential: async () => status(),
    openMicrophoneSettings: vi.fn(async () => {}),
    events,
  });
  const pair = memoryTransportPair();
  serve(pair.right, controller);
  return { remote: client(voiceContract, connect(pair.left)), events };
}

/** This computer's key mechanisms. */
function fakeKeys(taken: readonly string[] = []) {
  const shortcuts = new Map<string, () => void>();
  let hook: ((event: KeyEvent) => void) | null = null;
  const ports: GlobalVoiceKeyPorts = {
    globalShortcuts: {
      register: (accelerator, onPress) => {
        if (taken.includes(accelerator)) return false;
        shortcuts.set(accelerator, onPress);
        return true;
      },
      unregister: (accelerator) => void shortcuts.delete(accelerator),
    },
    keyboardHook: {
      start: (onKey) => {
        hook = onKey;
        return true;
      },
      stop: () => {
        hook = null;
      },
    },
  };
  return { ports, shortcuts, hookRunning: () => hook !== null };
}

/** A focus gate the test flips, standing in for the shared marker file. */
function fakeFocus(initial: boolean) {
  let active = initial;
  const listeners = new Set<(active: boolean) => void>();
  const gate: VoiceFocusGate = {
    active: () => active,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    gate,
    set: (next: boolean) => {
      active = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function setup(
  stored: Partial<VoiceSettings> = {},
  taken: readonly string[] = [],
  focus?: VoiceFocusGate
) {
  const host = fakeHost(stored);
  const keys = fakeKeys(taken);
  const openMicrophoneSettings = vi.fn(async () => {});
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  const controller = createClientVoiceController(host.remote, {
    openMicrophoneSettings,
    keys: keys.ports,
    logger: noopLogger,
    signal: lifetime.signal,
    ...(focus ? { focus } : {}),
  });
  const pair = memoryTransportPair();
  serve(pair.right, controller);
  const renderer = client(voiceContract, connect(pair.left));
  return { host, keys, renderer, lifetime, openMicrophoneSettings };
}

describe('client voice controller', () => {
  it("registers the host's stored toggle shortcut on this computer and reports it", async () => {
    const { keys, renderer } = setup({ globalShortcut: 'Control+Alt+Space' });
    await vi.waitFor(() => expect([...keys.shortcuts.keys()]).toEqual(['Control+Alt+Space']));

    const status = await renderer.getStatus(undefined);
    expect(status.globalShortcutRegistered).toBe(true);
    expect(status.globalHoldActive).toBe(false);
  });

  it('reports a shortcut another app on this computer owns as not registered', async () => {
    const { renderer } = setup({ globalShortcut: 'Control+Alt+Space' }, ['Control+Alt+Space']);
    expect((await renderer.getStatus(undefined)).globalShortcutRegistered).toBe(false);
  });

  it('starts and stops the local hold-to-talk hook when the setting changes', async () => {
    const { keys, renderer } = setup();
    let status = await renderer.updateSettings({ globalHoldKey: 'ControlRight' });
    expect(status.globalHoldActive).toBe(true);
    expect(keys.hookRunning()).toBe(true);

    status = await renderer.updateSettings({ globalHoldKey: 'off' });
    expect(status.globalHoldActive).toBe(false);
    expect(keys.hookRunning()).toBe(false);
  });

  it("emits this computer's key events and drops the host's, relaying everything else", async () => {
    const { host, keys, renderer } = setup({ globalShortcut: 'Control+Alt+Space' });
    const received: VoiceEvent[] = [];
    await renderer.events.subscribe(undefined, { onEvent: (event) => received.push(event) });
    await vi.waitFor(() => expect(keys.shortcuts.size).toBe(1));
    // The relay to the host's feed opens with the first renderer subscriber.
    await vi.waitFor(() => expect(host.events.resolve(undefined).subscriberCount).toBe(1));

    host.events.emit(undefined, { type: 'global-toggle' });
    host.events.emit(undefined, { type: 'global-hold', action: 'start', intent: 'command' });
    host.events.emit(undefined, { type: 'tts-done', requestId: 'r1' });
    await vi.waitFor(() => expect(received).toEqual([{ type: 'tts-done', requestId: 'r1' }]));

    keys.shortcuts.get('Control+Alt+Space')?.();
    await vi.waitFor(() =>
      expect(received).toEqual([{ type: 'tts-done', requestId: 'r1' }, { type: 'global-toggle' }])
    );
  });

  it('holds the keys only while this Maestro window was the one focused last', async () => {
    const focus = fakeFocus(false);
    const { keys, renderer } = setup(
      { globalShortcut: 'Control+Alt+Space', globalHoldKey: 'ControlRight' },
      [],
      focus.gate
    );
    // Another window owns the keys: nothing is registered, but the settings read as set.
    const status = await renderer.getStatus(undefined);
    expect(keys.shortcuts.size).toBe(0);
    expect(keys.hookRunning()).toBe(false);
    expect(status.globalShortcutRegistered).toBe(true);
    expect(status.globalHoldActive).toBe(true);

    focus.set(true);
    expect([...keys.shortcuts.keys()]).toEqual(['Control+Alt+Space']);
    expect(keys.hookRunning()).toBe(true);

    focus.set(false);
    expect(keys.shortcuts.size).toBe(0);
    expect(keys.hookRunning()).toBe(false);
  });

  it("opens this computer's microphone settings", async () => {
    const { renderer, openMicrophoneSettings } = setup();
    await renderer.openMicrophoneSettings(undefined);
    expect(openMicrophoneSettings).toHaveBeenCalledOnce();
  });

  it('releases the keys when the client quits', async () => {
    const { keys, renderer, lifetime } = setup({ globalHoldKey: 'ControlRight' });
    await renderer.getStatus(undefined);
    expect(keys.hookRunning()).toBe(true);
    lifetime.abort();
    expect(keys.hookRunning()).toBe(false);
    expect(keys.shortcuts.size).toBe(0);
  });
});
