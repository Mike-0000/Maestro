import {
  remoteDeviceWireContract,
  type RemoteVoiceEvent,
  type RemoteVoiceState,
} from '@emdash/core/services/remote-control/api';
import { err, ok, type Result } from '@emdash/shared';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import { createEventStreamHost } from '@emdash/wire/live';
import {
  blobSourceFromBytes,
  createInProcessWire,
  defineContract,
  type ContractClient,
} from '@emdash/wire/rpc';
import { observe, remote } from '@emdash/wire/state';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  remoteAccessContract,
  type RemoteConductorCommand,
  type RemoteConductorSnapshot,
} from '@core/features/remote-access/api';
import {
  DEFAULT_VOICE_SETTINGS,
  voiceContract,
  type Transcription,
  type VoiceError,
  type VoiceEvent,
} from '@core/features/voice/api';
import { chorusCredentialIds } from '@core/primitives/chorus-host/api/credentials';
import { createRemoteVoice, type RemoteVoice } from './remote-voice';
import { testRemoteControl } from './testing';

const SNAPSHOT: RemoteConductorSnapshot = {
  phase: 'thinking',
  activity: 'Reading Atlas',
  lastUtterance: 'what is Atlas doing',
  reply: 'Atlas is running the tests.',
  replyAt: 42,
  error: null,
  pending: { id: 1, label: 'Send to Atlas', kind: 'confirm', startedAt: 10, durationMs: 30000 },
  plan: null,
  agentNames: ['Atlas', 'Bravo'],
  vocabulary: ['Atlas', 'Bravo', 'chorus'],
};

type TranscribeResult = Result<Transcription, VoiceError>;

describe('remote voice', () => {
  let scope: Scope;
  let voiceEvents: ReturnType<typeof createEventStreamHost<typeof voiceContract.events>>;
  let ttsEngine: 'platform' | 'kitten';
  let transcribe: Mock<(input: { vocabulary: string[] }) => Promise<TranscribeResult>>;
  let startTts: Mock<(input: { requestId: string; text: string }) => Promise<void>>;
  let commands: RemoteConductorCommand[];
  let voice: RemoteVoice;
  let api: ContractClient<typeof remoteDeviceWireContract.remote.voice>;
  let hud: RemoteVoiceState | undefined;
  let received: RemoteVoiceEvent[];

  beforeEach(async () => {
    scope = createScope({ label: 'remote-voice-test' });
    voiceEvents = createEventStreamHost(voiceContract.events);
    ttsEngine = 'kitten';
    transcribe = vi.fn(
      async (): Promise<TranscribeResult> =>
        ok({ text: 'tell Atlas to run the tests', engine: 'openai', latencyMs: 120 })
    );
    startTts = vi.fn(async () => {});
    const host = createInProcessWire(voiceContract, {
      transcribe: (input: { vocabulary: string[] }) => transcribe(input),
      getStatus: () => ({
        settings: { ...DEFAULT_VOICE_SETTINGS, ttsEngine },
        credentials: Object.fromEntries(chorusCredentialIds.map((id) => [id, false])),
        globalShortcutRegistered: false,
        globalHoldActive: false,
      }),
      openStream: () => ({ supported: true, streamId: 'stream-1' }),
      pushAudio: () => {},
      closeStream: () => ok({ text: 'done talking', engine: 'deepgram' as const, latencyMs: 30 }),
      abortStream: () => {},
      startTts: (input: { requestId: string; text: string }) => startTts(input),
      stopTts: () => {},
      events: voiceEvents,
    } as never);
    scope.add(() => host.dispose());

    const conductorCommands = createEventStreamHost(remoteAccessContract.conductorCommands);
    commands = [];
    const window = createInProcessWire(
      defineContract({ conductorCommands: remoteAccessContract.conductorCommands }),
      { conductorCommands }
    );
    scope.add(() => window.dispose());
    scope.add(
      await window.client.conductorCommands.subscribe(undefined, {
        onEvent: (command) => commands.push(command),
      })
    );

    voice = createRemoteVoice({ voice: host.client, conductorCommands, scope });
    scope.add(() => voice.dispose());

    const device = createInProcessWire(remoteDeviceWireContract, {
      remote: testRemoteControl({ voice: voice.impl }),
    });
    scope.add(() => device.dispose());
    api = device.client.remote.voice;

    hud = undefined;
    const model = remote(remoteDeviceWireContract.remote.voice.state, api.state, { scope });
    observe(
      model(undefined).states.hud,
      (snapshot) => {
        if (snapshot.status !== 'loading') hud = snapshot.value;
      },
      { scope }
    );
    received = [];
    const stopEvents = await api.events.subscribe(undefined, {
      onEvent: (event) => received.push(event),
    });
    scope.add(stopEvents);
    await vi.waitFor(() => expect(hud).toBeDefined());
  });

  afterEach(async () => {
    await scope.dispose();
  });

  function emit(event: VoiceEvent): void {
    voiceEvents.emit(undefined, event);
  }

  it('is unavailable and refuses commands until the window reports in', async () => {
    expect(hud?.available).toBe(false);
    expect(await api.say({ text: 'focus Atlas' })).toMatchObject({
      success: false,
      error: { type: 'unavailable' },
    });
    expect(commands).toHaveLength(0);
  });

  it("mirrors the window's display and voices replies with the host engine", async () => {
    voice.publishConductorState(SNAPSHOT);
    await vi.waitFor(() => expect(hud?.available).toBe(true));
    await vi.waitFor(() => expect(hud?.speech).toBe('host'));
    expect(hud).toMatchObject({
      phase: 'thinking',
      reply: 'Atlas is running the tests.',
      replyAt: 42,
      pending: { kind: 'confirm', label: 'Send to Atlas' },
      agentNames: ['Atlas', 'Bravo'],
    });
  });

  it('tells devices to speak for themselves when the host uses its system voice', async () => {
    ttsEngine = 'platform';
    voice.publishConductorState(SNAPSHOT);
    await vi.waitFor(() => expect(hud?.available).toBe(true));
    expect(hud?.speech).toBe('device');
    expect(
      await api.speak({ requestId: '5b0c9c8e-6f0a-4c2e-9d57-0a4f0e8b6a11', text: 'hello' })
    ).toMatchObject({ success: false, error: { type: 'unsupported' } });
    expect(startTts).not.toHaveBeenCalled();
  });

  it('delivers words and answers to the window as commands', async () => {
    voice.publishConductorState(SNAPSHOT);
    expect((await api.say({ text: 'tell Atlas to run the tests' })).success).toBe(true);
    expect((await api.respond({ decision: 'no' })).success).toBe(true);
    await vi.waitFor(() =>
      expect(commands).toEqual([
        { type: 'utterance', text: 'tell Atlas to run the tests' },
        { type: 'respond', decision: 'no' },
      ])
    );
  });

  it('forwards only partials and audio that belong to device streams and requests', async () => {
    voice.publishConductorState(SNAPSHOT);
    await vi.waitFor(() => expect(hud?.speech).toBe('host'));
    const opened = await api.openStream({});
    expect(opened).toEqual({ success: true, data: { streamId: 'stream-1' } });
    const requestId = '0d3c4c6e-2a51-4a59-8a7e-5b9a2f6f8c21';
    expect((await api.speak({ requestId, text: 'Done.' })).success).toBe(true);

    emit({ type: 'partial', streamId: 'window-stream', text: 'not for devices' });
    emit({ type: 'partial', streamId: 'stream-1', text: 'tell Atlas' });
    emit({ type: 'tts-chunk', requestId: 'window-request', pcm: 'AAAA' });
    emit({ type: 'tts-chunk', requestId, pcm: 'AQID' });
    emit({ type: 'tts-done', requestId });
    emit({ type: 'global-toggle' });

    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toEqual([
      { type: 'partial', streamId: 'stream-1', text: 'tell Atlas' },
      { type: 'speech-chunk', requestId, pcm: 'AQID', sampleRate: 24_000 },
      { type: 'speech-done', requestId },
    ]);

    expect(await api.closeStream({ streamId: 'stream-1' })).toEqual({
      success: true,
      data: { text: 'done talking', latencyMs: 30 },
    });
    expect(await api.pushAudio({ streamId: 'stream-1', pcm: 'AAAA' })).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
  });

  it('reports speech-to-text that is not set up', async () => {
    voice.publishConductorState(SNAPSHOT);
    transcribe.mockResolvedValueOnce(
      err({ type: 'not-configured', message: 'Add an OpenAI API key.' })
    );
    const file = {
      name: 'utterance.wav',
      mimeType: 'audio/wav',
      source: blobSourceFromBytes(new Uint8Array(64)),
    };

    expect(await api.transcribe({}, file)).toEqual({
      success: false,
      error: { type: 'unavailable', message: 'Add an OpenAI API key.' },
    });
    await vi.waitFor(() => expect(hud?.transcriptionReady).toBe(false));
    expect(transcribe.mock.calls[0]?.[0]).toEqual({ vocabulary: ['Atlas', 'Bravo', 'chorus'] });

    expect(await api.transcribe({}, file)).toEqual({
      success: true,
      data: { text: 'tell Atlas to run the tests', latencyMs: 120 },
    });
    await vi.waitFor(() => expect(hud?.transcriptionReady).toBe(true));
  });
});
