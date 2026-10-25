import { err, ok } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import { createEventStreamHost } from '@emdash/wire/live';
import { createController, type Controller } from '@emdash/wire/rpc';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { voiceContract } from '../api/contract';
import { base64ToBytes } from '../api/wav';
import { SttEngineError } from './engines/engine';
import { VoiceService } from './voice-service';

export const voiceEvents = createEventStreamHost(voiceContract.events);

export function createVoiceWireController(options: {
  host: ChorusHostServices;
  logger: Logger;
  scope: Scope;
}): { controller: Controller; service: VoiceService } {
  const service = new VoiceService(
    options.host,
    () => voiceEvents.emit(undefined, { type: 'global-toggle' }),
    options.logger,
    (output) =>
      voiceEvents.emit(undefined, {
        type: 'global-hold',
        action: output.type,
        ...(output.type === 'start' ? { intent: output.intent } : {}),
      })
  );
  void service.start().catch((error: unknown) => {
    options.logger.warn('voice: failed to start', { error });
  });
  options.scope.add(() => service.dispose());

  const controller = createController(voiceContract, {
    transcribe: async ({ vocabulary }, file) => {
      try {
        return ok(await service.transcribe(await file.bytes(), vocabulary));
      } catch (error) {
        if (error instanceof SttEngineError)
          return err({ type: error.kind, message: error.message });
        options.logger.error('voice: transcription failed', { error });
        return err({
          type: 'engine-failed' as const,
          message: error instanceof Error ? error.message : 'Transcription failed.',
        });
      }
    },
    getStatus: () => service.status(),
    openStream: async ({ vocabulary }) => {
      const streamId = await service
        .openStream(vocabulary, (id, text, confidence) =>
          voiceEvents.emit(undefined, {
            type: 'partial',
            streamId: id,
            text,
            ...(confidence !== undefined ? { confidence } : {}),
          })
        )
        .catch((error: unknown) => {
          options.logger.warn('voice: could not open a stream', { error });
          return null;
        });
      return { supported: streamId !== null, streamId };
    },
    pushAudio: ({ streamId, pcm }) => service.pushAudio(streamId, base64ToBytes(pcm)),
    closeStream: async ({ streamId }) => {
      try {
        return ok(await service.closeStream(streamId));
      } catch (error) {
        if (error instanceof SttEngineError)
          return err({ type: error.kind, message: error.message });
        options.logger.error('voice: stream failed', { error });
        return err({ type: 'engine-failed' as const, message: 'Live transcription failed.' });
      }
    },
    abortStream: ({ streamId }) => service.abortStream(streamId),
    getDictationModel: () => service.dictationModel(),
    downloadDictationModel: () =>
      service.downloadDictationModel((status) =>
        voiceEvents.emit(undefined, { type: 'dictation-model', status })
      ),
    openDictation: async () => {
      try {
        const streamId = await service.openDictation((id, text) =>
          voiceEvents.emit(undefined, { type: 'partial', streamId: id, text })
        );
        return ok({ streamId });
      } catch (error) {
        if (error instanceof SttEngineError)
          return err({ type: error.kind, message: error.message });
        options.logger.error('voice: dictation could not start', { error });
        return err({ type: 'engine-failed' as const, message: 'Dictation could not start.' });
      }
    },
    warmDictation: () => service.warmDictation().catch(() => {}),
    closeDictation: async ({ streamId }) => {
      try {
        return ok(await service.closeDictation(streamId));
      } catch (error) {
        if (error instanceof SttEngineError)
          return err({ type: error.kind, message: error.message });
        options.logger.error('voice: dictation failed', { error });
        return err({ type: 'engine-failed' as const, message: 'Dictation failed.' });
      }
    },
    startTts: ({ requestId, text }) =>
      service.startTts(requestId, text, (event) => {
        if (event.type === 'chunk') {
          voiceEvents.emit(undefined, {
            type: 'tts-chunk',
            requestId,
            pcm: event.pcm,
            ...(event.sampleRate ? { sampleRate: event.sampleRate } : {}),
          });
        } else {
          voiceEvents.emit(undefined, {
            type: event.type === 'done' ? 'tts-done' : 'tts-error',
            requestId,
          });
        }
      }),
    stopTts: ({ requestId }) => service.stopTts(requestId),
    updateSettings: (patch) => service.updateSettings(patch),
    setCredential: ({ id, value }) => service.setCredential(id, value),
    openMicrophoneSettings: () => options.host.openMicrophoneSettings(),
    events: voiceEvents,
  });
  return { controller, service };
}
