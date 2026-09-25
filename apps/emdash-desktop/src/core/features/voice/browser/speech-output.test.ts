import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVoiceClient } from '../api/browser/client';
import { DEFAULT_VOICE_SETTINGS } from '../api/contract';
import { SpeechOutput } from './speech-output';

vi.mock('../api/browser/client', () => ({ getVoiceClient: vi.fn() }));

const startTts = vi.fn(async (_input: { requestId: string; text: string }) => {});
const stopTts = vi.fn(async (_input: { requestId: string }) => {});
const speak = vi.fn();
const cancel = vi.fn();
const sources: Array<{ stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  sources.length = 0;
  vi.mocked(getVoiceClient).mockResolvedValue({ startTts, stopTts } as never);
  vi.stubGlobal('speechSynthesis', { cancel, speak, getVoices: () => [] });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(readonly text: string) {}
    }
  );
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 0;
      state = 'running';
      destination = {};
      createBuffer(_channels: number, length: number, _rate: number) {
        return { duration: length / 24_000, getChannelData: () => new Float32Array(length) };
      }
      createBufferSource() {
        const source = {
          buffer: null,
          onended: null as (() => void) | null,
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        sources.push(source);
        return source;
      }
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SpeechOutput', () => {
  it('keeps the platform voice as the default and fallback with no Gemini key', () => {
    const output = new SpeechOutput();
    output.speak('Ready.');
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'gemini-flash' }, false);
    output.speak('Sent to Atlas.');
    expect(speak).toHaveBeenCalledTimes(2);
    expect(startTts).not.toHaveBeenCalled();
    output.stop();
  });

  it('uses the bundled model without any cloud credential, then falls back if it fails', async () => {
    const output = new SpeechOutput();
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'kitten' }, false);
    output.speak('Ready.');
    await vi.waitFor(() => expect(startTts).toHaveBeenCalledTimes(1));
    const { requestId } = startTts.mock.calls[0]![0];
    output.handleEvent({ type: 'tts-error', requestId });
    expect(speak).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(stopTts).toHaveBeenCalledWith({ requestId }));
    output.stop();
  });

  it('streams Gemini audio and interrupts playback and the upstream request on stop', async () => {
    const output = new SpeechOutput();
    const speaking = vi.fn();
    output.onSpeakingChange = speaking;
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'gemini-flash' }, true);
    output.speak('Sent to Atlas.');
    await vi.waitFor(() => expect(startTts).toHaveBeenCalledTimes(1));
    const { requestId } = startTts.mock.calls[0]![0];
    output.handleEvent({
      type: 'tts-chunk',
      requestId,
      pcm: Buffer.from([0, 0, 255, 127]).toString('base64'),
    });
    expect(sources).toHaveLength(1);
    expect(speaking).toHaveBeenLastCalledWith(true);
    output.stop();
    await vi.waitFor(() => expect(stopTts).toHaveBeenCalledWith({ requestId }));
    expect(sources[0]?.stop).toHaveBeenCalled();
    output.handleEvent({ type: 'tts-done', requestId });
    expect(speaking).toHaveBeenLastCalledWith(false);
    expect(speak).not.toHaveBeenCalled();
  });

  it('finishes after the last streamed chunk actually plays', async () => {
    const output = new SpeechOutput();
    const speaking = vi.fn();
    output.onSpeakingChange = speaking;
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'gemini-flash' }, true);
    output.speak('Ready.');
    await vi.waitFor(() => expect(startTts).toHaveBeenCalledTimes(1));
    const { requestId } = startTts.mock.calls[0]![0];
    output.handleEvent({
      type: 'tts-chunk',
      requestId,
      pcm: Buffer.from([0, 0]).toString('base64'),
    });
    output.handleEvent({ type: 'tts-done', requestId });
    expect(speaking).toHaveBeenLastCalledWith(true);
    sources[0]?.onended?.();
    expect(speaking).toHaveBeenLastCalledWith(false);
    output.stop();
  });

  it('falls back after a stalled request without playing late cloud audio', async () => {
    vi.useFakeTimers();
    const output = new SpeechOutput();
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'gemini-flash' }, true);
    output.speak('Ready.');
    await vi.advanceTimersByTimeAsync(0);
    expect(startTts).toHaveBeenCalledTimes(1);
    const { requestId } = startTts.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(3500);
    expect(speak).toHaveBeenCalledTimes(1);
    output.handleEvent({
      type: 'tts-chunk',
      requestId,
      pcm: Buffer.from([0, 0]).toString('base64'),
    });
    expect(sources).toHaveLength(0);
    output.stop();
  });

  it('falls back when the cloud fails before audio and ignores late events', async () => {
    const output = new SpeechOutput();
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'gemini-flash-lite' }, true);
    output.speak('Ready.');
    await vi.waitFor(() => expect(startTts).toHaveBeenCalledTimes(1));
    const { requestId } = startTts.mock.calls[0]![0];
    output.handleEvent({ type: 'tts-error', requestId });
    expect(speak).toHaveBeenCalledTimes(1);
    output.handleEvent({
      type: 'tts-chunk',
      requestId,
      pcm: Buffer.from([0, 0]).toString('base64'),
    });
    expect(sources).toHaveLength(0);
    output.stop();
  });

  it('reports platform speech starting, finishing and barge-in without claiming cancelled speech finished', () => {
    type Utterance = { onstart?: () => void; onend?: () => void };
    const output = new SpeechOutput();
    const statuses: string[] = [];
    output.speak('first', (status) => statuses.push(status));
    const first = speak.mock.calls.at(-1)![0] as Utterance;
    first.onstart?.();
    output.stop();
    first.onend?.();
    expect(statuses).toEqual(['started', 'cancelled']);
    output.speak('second', (status) => statuses.push(status));
    const second = speak.mock.calls.at(-1)![0] as Utterance;
    second.onstart?.();
    second.onend?.();
    expect(statuses).toEqual(['started', 'cancelled', 'started', 'ended']);
  });

  it('reports streamed model speech once and falls back to the platform voice with one listener', async () => {
    const output = new SpeechOutput();
    output.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'kitten' }, false);
    const statuses: string[] = [];
    output.speak('Ready.', (status) => statuses.push(status));
    await vi.waitFor(() => expect(startTts).toHaveBeenCalledTimes(1));
    const { requestId } = startTts.mock.calls[0]![0];
    output.handleEvent({ type: 'tts-error', requestId });
    const fallback = speak.mock.calls.at(-1)![0] as { onstart?: () => void; onend?: () => void };
    fallback.onstart?.();
    fallback.onend?.();
    expect(statuses).toEqual(['started', 'ended']);
  });
});
