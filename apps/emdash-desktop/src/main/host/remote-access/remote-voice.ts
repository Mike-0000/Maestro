import {
  remoteDeviceWireContract,
  type RemoteControlError,
  type RemoteVoiceEvent,
  type RemoteVoiceState,
} from '@emdash/core/services/remote-control/api';
import { err, ok, type Result, type Unsubscribe } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { createEventStreamHost, type EventStreamHost } from '@emdash/wire/live';
import type { ContractClient, ContractImpl, WireFile } from '@emdash/wire/rpc';
import { cell, expose } from '@emdash/wire/state';
import type {
  remoteAccessContract,
  RemoteConductorCommand,
  RemoteConductorSnapshot,
} from '@core/features/remote-access/api';
import type { VoiceEvent, voiceContract } from '@core/features/voice/api';

const voiceRemote = remoteDeviceWireContract.remote.voice;

export type RemoteVoiceImpl = ContractImpl<typeof voiceRemote>;

type VoiceClient = ContractClient<typeof voiceContract>;

const UNAVAILABLE_STATE: RemoteVoiceState = {
  available: false,
  transcriptionReady: true,
  phase: 'idle',
  activity: '',
  lastUtterance: '',
  reply: '',
  replyAt: 0,
  error: null,
  pending: null,
  plan: null,
  agentNames: [],
  speech: 'device',
};

const DEFAULT_SAMPLE_RATE = 24_000;
/** Owned ids are forgotten after this long even if their stream never reported an end. */
const OWNED_ID_TTL_MS = 10 * 60_000;

export type ConductorCommandHost = EventStreamHost<typeof remoteAccessContract.conductorCommands>;

export type RemoteVoice = {
  impl: RemoteVoiceImpl;
  /** The window reported the conductor's display. */
  publishConductorState(snapshot: RemoteConductorSnapshot): void;
  dispose(): void;
};

export type RemoteVoiceOptions = {
  voice: VoiceClient;
  /** Carries device commands to the conductor in the window. */
  conductorCommands: ConductorCommandHost;
  /** The display the window reported before this was created, if it already has. */
  snapshot?: RemoteConductorSnapshot;
  scope: Scope;
};

/**
 * Voice for paired devices. The conductor lives in the window, so this relays in both
 * directions: a device's words go to the window as commands, and the window's heads-up display
 * comes back as live state. Transcription and synthesis use the host's own voice service, so
 * no key ever reaches a device.
 */
export function createRemoteVoice(options: RemoteVoiceOptions): RemoteVoice {
  const { voice, scope, conductorCommands } = options;
  const state = cell<RemoteVoiceState>(UNAVAILABLE_STATE);
  const events = createEventStreamHost(voiceRemote.events);
  // Streams and speech requests opened by devices; the window's own never leave this computer.
  const ownedStreams = new Map<string, number>();
  const ownedSpeech = new Map<string, number>();
  let vocabulary: string[] = options.snapshot?.vocabulary ?? [];
  let transcriptionReady = true;
  let speech: RemoteVoiceState['speech'] = 'device';
  let snapshot: RemoteConductorSnapshot | undefined = options.snapshot;
  let stopEvents: Unsubscribe | undefined;
  let disposed = false;

  function publish(): void {
    state.set(
      snapshot
        ? {
            available: true,
            transcriptionReady,
            phase: snapshot.phase,
            activity: snapshot.activity,
            lastUtterance: snapshot.lastUtterance,
            reply: snapshot.reply,
            replyAt: snapshot.replyAt,
            error: snapshot.error,
            pending: snapshot.pending,
            plan: snapshot.plan,
            agentNames: snapshot.agentNames,
            speech,
          }
        : { ...UNAVAILABLE_STATE, transcriptionReady, speech }
    );
  }

  async function refreshSpeechMode(): Promise<void> {
    try {
      const status = await voice.getStatus();
      const next = status.settings.ttsEngine === 'platform' ? 'device' : 'host';
      if (next !== speech) {
        speech = next;
        publish();
      }
    } catch {
      // The voice service is not up yet; devices keep using their own speech.
    }
  }

  function forward(event: VoiceEvent): void {
    const translated = translate(event);
    if (translated) events.emit(undefined, translated);
  }

  function translate(event: VoiceEvent): RemoteVoiceEvent | undefined {
    switch (event.type) {
      case 'partial':
        return ownedStreams.has(event.streamId)
          ? { type: 'partial', streamId: event.streamId, text: event.text }
          : undefined;
      case 'tts-chunk':
        return ownedSpeech.has(event.requestId)
          ? {
              type: 'speech-chunk',
              requestId: event.requestId,
              pcm: event.pcm,
              sampleRate: event.sampleRate ?? DEFAULT_SAMPLE_RATE,
            }
          : undefined;
      case 'tts-done':
      case 'tts-error': {
        if (!ownedSpeech.delete(event.requestId)) return undefined;
        return {
          type: event.type === 'tts-done' ? 'speech-done' : 'speech-error',
          requestId: event.requestId,
        };
      }
      default:
        return undefined;
    }
  }

  function own(owned: Map<string, number>, id: string): void {
    const now = Date.now();
    for (const [key, at] of owned) if (now - at > OWNED_ID_TTL_MS) owned.delete(key);
    owned.set(id, now);
  }

  void voice.events
    .subscribe(undefined, { onEvent: forward })
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else stopEvents = unsubscribe;
    })
    .catch(() => {});
  publish();
  void refreshSpeechMode();

  const impl: RemoteVoiceImpl = {
    state: expose(voiceRemote.state, { hud: state }, { scope }),
    events,

    transcribe: async (_input, file: WireFile) => {
      const result = await attempt(() => voice.transcribe({ vocabulary }, file));
      const ready = result.success || result.error.type !== 'not-configured';
      if (ready !== transcriptionReady) {
        transcriptionReady = ready;
        publish();
      }
      return result.success
        ? ok({ text: result.data.text, latencyMs: result.data.latencyMs })
        : err(remoteError(result.error));
    },

    openStream: async () => {
      try {
        const opened = await voice.openStream({ vocabulary });
        const streamId = opened.supported ? opened.streamId : null;
        if (streamId) own(ownedStreams, streamId);
        return ok({ streamId });
      } catch (error) {
        return err(remoteError(error));
      }
    },
    pushAudio: async ({ streamId, pcm }) => {
      if (!ownedStreams.has(streamId)) return err(notFound('That recording is no longer open.'));
      try {
        await voice.pushAudio({ streamId, pcm });
        return ok<void>();
      } catch (error) {
        return err(remoteError(error));
      }
    },
    closeStream: async ({ streamId }) => {
      if (!ownedStreams.delete(streamId)) return err(notFound('That recording is no longer open.'));
      const result = await attempt(() => voice.closeStream({ streamId }));
      return result.success
        ? ok({ text: result.data.text, latencyMs: result.data.latencyMs })
        : err(remoteError(result.error));
    },
    abortStream: async ({ streamId }) => {
      if (ownedStreams.delete(streamId)) await voice.abortStream({ streamId }).catch(() => {});
      return ok<void>();
    },

    say: async ({ text }) => deliver({ type: 'utterance', text }),
    respond: async ({ decision }) => deliver({ type: 'respond', decision }),

    speak: async ({ requestId, text }) => {
      await refreshSpeechMode();
      if (speech !== 'host') {
        return err({
          type: 'unsupported',
          message: 'The host uses its system voice; speak the reply on this device.',
        });
      }
      own(ownedSpeech, requestId);
      try {
        await voice.startTts({ requestId, text });
        return ok<void>();
      } catch (error) {
        ownedSpeech.delete(requestId);
        return err(remoteError(error));
      }
    },
    stopSpeaking: async ({ requestId }) => {
      if (ownedSpeech.delete(requestId)) await voice.stopTts({ requestId }).catch(() => {});
      return ok<void>();
    },
  };

  function deliver(command: RemoteConductorCommand): Result<void, RemoteControlError> {
    if (!snapshot) {
      return err({
        type: 'unavailable',
        message: 'The Maestro window on the host is not ready for voice commands yet.',
      });
    }
    conductorCommands.emit(undefined, command);
    return ok<void>();
  }

  return {
    impl,
    publishConductorState(next) {
      snapshot = next;
      vocabulary = next.vocabulary;
      publish();
      void refreshSpeechMode();
    },
    dispose() {
      disposed = true;
      stopEvents?.();
    },
  };
}

async function attempt<T>(
  call: () => Promise<Result<T, { type: string; message: string }>>
): Promise<Result<T, { type: string; message: string }>> {
  try {
    return await call();
  } catch (error) {
    return err({
      type: 'engine-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function remoteError(error: unknown): RemoteControlError {
  const type = (error as { type?: unknown } | null)?.type;
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : String(error);
  return {
    type: type === 'not-configured' || type === 'unreachable' ? 'unavailable' : 'failed',
    message,
  };
}

function notFound(message: string): RemoteControlError {
  return { type: 'not-found', message };
}
