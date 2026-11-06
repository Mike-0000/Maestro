import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioDevicesStore, type MediaDevicesLike } from './audio-devices';
import { LiveMicrophone } from './live-microphone';

vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

class FakeTrack extends EventTarget {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  constructor(readonly constraints: MediaTrackConstraints) {}
  getAudioTracks() {
    return [this.track];
  }
  getTracks() {
    return [this.track];
  }
}

type FakeSource = { stream: FakeStream; connected: unknown; disconnect: () => void };

function fakeContext() {
  const sources: FakeSource[] = [];
  const context = {
    createMediaStreamSource(stream: FakeStream) {
      const source: FakeSource = {
        stream,
        connected: null,
        disconnect: () => {
          source.connected = null;
        },
      };
      sources.push(source);
      return Object.assign(source, {
        connect: (target: unknown) => {
          source.connected = target;
        },
      });
    },
  };
  return { context: context as unknown as AudioContext, sources };
}

let devicesList: MediaDeviceInfo[] = [];
const changeListeners = new Set<() => void>();
const media: MediaDevicesLike = {
  enumerateDevices: async () => devicesList,
  addEventListener: (_type, listener) => changeListeners.add(listener),
  removeEventListener: (_type, listener) => changeListeners.delete(listener),
};
const getUserMedia = vi.fn(
  async (request: { audio: MediaTrackConstraints }) => new FakeStream(request.audio)
);

function info(kind: MediaDeviceKind, deviceId: string, label: string, groupId: string) {
  return { kind, deviceId, label, groupId } as MediaDeviceInfo;
}

async function changeDefaultTo(label: string, groupId: string, store: AudioDevicesStore) {
  devicesList = [
    info('audioinput', 'default', `Default - ${label}`, groupId),
    info('audioinput', 'mic-headset', 'Headset', 'g-headset'),
    info('audioinput', 'mic-laptop', 'Laptop', 'g-laptop'),
  ];
  for (const listener of changeListeners) listener();
  await store.refresh();
}

beforeEach(() => {
  getUserMedia.mockClear();
  changeListeners.clear();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveMicrophone', () => {
  it('reopens on the new default and swaps it in under the same target', async () => {
    const store = new AudioDevicesStore(media, null);
    store.activate();
    await changeDefaultTo('Headset', 'g-headset', store);
    const { context, sources } = fakeContext();
    const target = { name: 'worklet' } as unknown as AudioNode;
    const microphone = new LiveMicrophone(context, target, { channelCount: 1 }, store);
    await microphone.open();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.connected).toBe(target);

    await changeDefaultTo('Laptop', 'g-laptop', store);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1]?.connected).toBe(target);
    expect(sources[0]?.connected).toBeNull();
    expect(sources[0]?.stream.track.stopped).toBe(true);

    microphone.close();
    expect(sources[1]?.stream.track.stopped).toBe(true);
    expect(sources[1]?.connected).toBeNull();
  });

  it('opens the picked microphone, and moves when an unplugged track ends', async () => {
    const store = new AudioDevicesStore(media, null);
    store.activate();
    await changeDefaultTo('Laptop', 'g-laptop', store);
    store.setInput({ id: 'mic-headset', label: 'Headset' });
    const { context, sources } = fakeContext();
    const microphone = new LiveMicrophone(context, {} as AudioNode, {}, store);
    await microphone.open();
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: 'mic-headset' } },
    });

    sources[0]?.stream.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    microphone.close();
  });

  it('falls back to the default when the picked microphone cannot be found', async () => {
    const store = new AudioDevicesStore(media, null);
    store.activate();
    await changeDefaultTo('Laptop', 'g-laptop', store);
    store.setInput({ id: 'mic-headset', label: 'Headset' });
    getUserMedia.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'));
    const { context, sources } = fakeContext();
    const microphone = new LiveMicrophone(context, {} as AudioNode, { channelCount: 1 }, store);
    await microphone.open();
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { channelCount: 1 } });
    expect(sources).toHaveLength(1);
    microphone.close();
  });
});
