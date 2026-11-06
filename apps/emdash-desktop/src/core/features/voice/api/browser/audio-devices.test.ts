import { describe, expect, it, vi } from 'vitest';
import { AudioDevicesStore, type MediaDevicesLike, type StorageLike } from './audio-devices';

type Device = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label' | 'groupId'>;

function device(kind: MediaDeviceKind, deviceId: string, label: string, groupId = deviceId) {
  return { kind, deviceId, label, groupId } satisfies Device;
}

const headset = device('audioinput', 'mic-headset', 'Headset Microphone (Jabra)', 'g-headset');
const laptop = device('audioinput', 'mic-laptop', 'Microphone Array (Realtek)', 'g-laptop');
const headphones = device('audiooutput', 'out-headset', 'Headphones (Jabra)', 'g-headset');
const speakers = device('audiooutput', 'out-laptop', 'Speakers (Realtek)', 'g-laptop');

function defaultOf(target: Device): Device {
  return { ...target, deviceId: 'default', label: `Default - ${target.label}` };
}

function fakeMedia(initial: Device[]) {
  let list = initial;
  const listeners = new Set<() => void>();
  const media: MediaDevicesLike = {
    enumerateDevices: async () => list as MediaDeviceInfo[],
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    media,
    /** Windows changed something: the list is read again, as on `devicechange`. */
    change(next: Device[]) {
      list = next;
      for (const listener of listeners) listener();
    },
  };
}

function memoryStorage(
  seed: Record<string, string> = {}
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

async function settled(store: AudioDevicesStore): Promise<void> {
  await store.refresh();
}

describe('AudioDevicesStore', () => {
  it('lists real devices with the Windows default named apart', async () => {
    const { media } = fakeMedia([
      defaultOf(headset),
      device('audioinput', 'communications', 'Communications - Headset', 'g-headset'),
      headset,
      laptop,
      defaultOf(headphones),
      headphones,
      speakers,
    ]);
    const store = new AudioDevicesStore(media, memoryStorage());
    store.activate();
    await settled(store);
    expect(store.inputs.map((d) => d.id)).toEqual(['mic-headset', 'mic-laptop']);
    expect(store.outputs.map((d) => d.id)).toEqual(['out-headset', 'out-laptop']);
    expect(store.defaultInputLabel).toBe('Headset Microphone (Jabra)');
    expect(store.inputDeviceId).toBeNull();
    expect(store.audioConstraints({ channelCount: 1 })).toEqual({ channelCount: 1 });
  });

  it('tells open microphones when the Windows default moves to another device', async () => {
    const fake = fakeMedia([defaultOf(headset), headset, laptop]);
    const store = new AudioDevicesStore(fake.media, memoryStorage());
    store.activate();
    await settled(store);
    const moved = vi.fn();
    store.onInputChange(moved);

    fake.change([defaultOf(laptop), headset, laptop]);
    await settled(store);
    expect(moved).toHaveBeenCalledTimes(1);

    // Another device plugged in, the default unchanged: nothing to reopen.
    fake.change([defaultOf(laptop), headset, laptop, device('audioinput', 'usb', 'USB Mic')]);
    await settled(store);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('keeps a picked microphone when the default moves, and falls back while it is unplugged', async () => {
    const fake = fakeMedia([defaultOf(laptop), headset, laptop]);
    const storage = memoryStorage();
    const store = new AudioDevicesStore(fake.media, storage);
    store.activate();
    await settled(store);
    const moved = vi.fn();
    store.onInputChange(moved);

    store.setInput({ id: headset.deviceId, label: headset.label });
    expect(moved).toHaveBeenCalledTimes(1);
    expect(store.audioConstraints({})).toEqual({ deviceId: { exact: 'mic-headset' } });
    expect(JSON.parse(storage.data.get('chorus:audio-input-device') ?? '')).toEqual({
      id: 'mic-headset',
      label: headset.label,
    });

    fake.change([defaultOf(headset), headset, laptop]);
    await settled(store);
    expect(moved).toHaveBeenCalledTimes(1);

    // The headset goes away: the default is used until it is back.
    fake.change([defaultOf(laptop), laptop]);
    await settled(store);
    expect(store.inputMissing).toBe(true);
    expect(store.inputDeviceId).toBeNull();
    expect(moved).toHaveBeenCalledTimes(2);

    fake.change([defaultOf(laptop), headset, laptop]);
    await settled(store);
    expect(store.inputDeviceId).toBe('mic-headset');
    expect(moved).toHaveBeenCalledTimes(3);

    store.setInput(null);
    expect(storage.data.has('chorus:audio-input-device')).toBe(false);
    expect(store.inputDeviceId).toBeNull();
  });

  it('restores a saved pick, matching by name when the id changed', async () => {
    const storage = memoryStorage({
      'chorus:audio-output-device': JSON.stringify({ id: 'stale-id', label: speakers.label }),
    });
    const { media } = fakeMedia([defaultOf(headphones), headphones, speakers]);
    const store = new AudioDevicesStore(media, storage);
    const routed = vi.fn();
    store.onOutputChange(routed);
    store.activate();
    await settled(store);
    expect(store.outputSinkId).toBe('out-laptop');
    expect(routed).toHaveBeenCalledTimes(1);

    store.setOutput(null);
    expect(store.outputSinkId).toBe('');
    expect(routed).toHaveBeenCalledTimes(2);
  });

  it('ignores unreadable saved picks', () => {
    const storage = memoryStorage({ 'chorus:audio-input-device': '{not json' });
    const store = new AudioDevicesStore(null, storage);
    expect(store.input).toBeNull();
  });
});
