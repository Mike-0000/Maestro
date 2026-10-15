import { conductorStoreToken } from '@core/features/conductor/contributions/browser/app-stores';
import { voiceStoreToken } from '@core/features/voice/contributions/browser/app-stores';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { getTalkClient } from '../../api/browser/client';
import { GrokVoiceSession, type SocketLike } from '../../browser/grok-voice-session';
import { createLineAudio } from '../../browser/line-audio';
import { TalkStore } from '../../browser/talk-store';

export const talkStoreToken = scopedStoreToken<TalkStore>('talk');

let player: HTMLAudioElement | null = null;

/** Plays the provider's voice through an audio element; null stops it. */
function play(stream: MediaStream | null, muted: boolean): void {
  if (!stream) {
    if (player) {
      player.pause();
      player.srcObject = null;
    }
    return;
  }
  player ??= new Audio();
  player.autoplay = true;
  player.muted = muted;
  player.srcObject = stream;
  void player.play().catch(() => {
    // Autoplay can be refused before the first click; the next sentence tries again.
  });
}

/** The microphone as the line hears it. Echo cancellation keeps the voice out of it. */
async function microphone(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No microphone is available.');
  return track;
}

// Resolves the voice and conductor stores at create time; register after both.
export const talkAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: talkStoreToken,
    create: (_context, stores) =>
      new TalkStore({
        client: getTalkClient,
        conductor: stores.get(conductorStoreToken),
        voice: stores.get(voiceStoreToken),
        createSession: (deps) =>
          new GrokVoiceSession({
            ...deps,
            // The browser's socket has more than the session uses; it is used as is.
            createSocket: (url, protocols) => new WebSocket(url, protocols) as SocketLike,
            createAudio: createLineAudio,
          }),
        microphone,
        play,
      }),
    activate: (store) => store.activate(),
    dispose: (store) => store.dispose(),
  }),
];

/** Returns the app-scoped TalkStore. */
export function getTalkStore(): TalkStore {
  return getAppStores().get(talkStoreToken);
}
