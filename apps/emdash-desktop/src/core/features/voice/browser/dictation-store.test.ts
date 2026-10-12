import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceEvent } from '../api/contract';
import { DictationStore } from './dictation-store';
import { MicRecorder } from './mic-recorder';

const { client, emit } = vi.hoisted(() => {
  let onEvent: ((event: unknown) => void) | null = null;
  return {
    emit: (event: unknown) => onEvent?.(event),
    client: {
      events: {
        subscribe: async (_key: undefined, handlers: { onEvent: (event: unknown) => void }) => {
          onEvent = handlers.onEvent;
          return () => {};
        },
      },
      openDictation: vi.fn(),
      closeDictation: vi.fn(),
      pushAudio: vi.fn(),
      abortStream: vi.fn(),
      getDictationModel: vi.fn(),
      downloadDictationModel: vi.fn(),
    },
  };
});
vi.mock('../api/browser/client', () => ({ getVoiceClient: async () => client }));

const send = (event: VoiceEvent) => emit(event);

function store(capturing = false): DictationStore {
  const dictation = new DictationStore({ capturing: () => capturing, quiet: () => {} });
  dictation.activate();
  return dictation;
}

beforeEach(() => {
  vi.spyOn(MicRecorder.prototype, 'start').mockResolvedValue();
  vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
    wav: new Uint8Array(),
    durationMs: 1000,
  });
  vi.spyOn(MicRecorder.prototype, 'cancel').mockReturnValue();
  for (const mock of Object.values(client)) if ('mockReset' in mock) mock.mockReset();
  client.openDictation.mockResolvedValue({ success: true, data: { streamId: 's1' } });
  client.closeDictation.mockResolvedValue({
    success: true,
    data: { text: 'Fix the lint error.', latencyMs: 80 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DictationStore', () => {
  it('shows the words as they are heard and sends the final text to the open agent', async () => {
    const dictation = store();
    const sent: string[] = [];
    dictation.setSender(async (text) => {
      sent.push(text);
      return { ok: true, agentName: 'Atlas' };
    });
    dictation.toggle();
    await vi.waitFor(() => expect(client.openDictation).toHaveBeenCalled());
    expect(dictation.phase).toBe('listening');
    await Promise.resolve();
    send({ type: 'partial', streamId: 'other', text: 'not mine' });
    send({ type: 'partial', streamId: 's1', text: 'Fix the lint' });
    expect(dictation.text).toBe('Fix the lint');

    dictation.toggle();
    await vi.waitFor(() => expect(dictation.phase).toBe('idle'));
    expect(sent).toEqual(['Fix the lint error.']);
    expect(dictation.sentTo).toBe('Atlas');
    expect(dictation.text).toBe('');
    dictation.dispose();
  });

  it('keeps the words when they cannot be sent, and sends them on the next try', async () => {
    const dictation = store();
    let open = false;
    dictation.setSender(async () =>
      open ? { ok: true, agentName: 'Atlas' } : { ok: false, message: 'No agent is open.' }
    );
    await dictation.start();
    await dictation.finish();
    expect(dictation.phase).toBe('review');
    expect(dictation.text).toBe('Fix the lint error.');
    expect(dictation.error).toBe('No agent is open.');

    open = true;
    dictation.toggle();
    await vi.waitFor(() => expect(dictation.phase).toBe('idle'));
    expect(dictation.sentTo).toBe('Atlas');
    dictation.dispose();
  });

  it('asks for the model instead of listening when it is not downloaded', async () => {
    client.openDictation.mockResolvedValue({
      success: false,
      error: { type: 'not-configured', message: 'The dictation model is not downloaded yet.' },
    });
    client.getDictationModel.mockResolvedValue({
      state: 'missing',
      receivedBytes: 0,
      totalBytes: 663_000_000,
    });
    const dictation = store();
    await dictation.start();
    await vi.waitFor(() => expect(dictation.phase).toBe('setup'));
    expect(MicRecorder.prototype.cancel).toHaveBeenCalled();
    await vi.waitFor(() => expect(dictation.model?.state).toBe('missing'));

    send({
      type: 'dictation-model',
      status: { state: 'downloading', receivedBytes: 10, totalBytes: 663_000_000 },
    });
    expect(dictation.model?.state).toBe('downloading');
    // A tap closes the setup panel; it never sends.
    dictation.toggle();
    expect(dictation.phase).toBe('idle');
    dictation.dispose();
  });

  it('sends nothing when nothing was said or it was cancelled', async () => {
    const dictation = store();
    const sender = vi.fn();
    dictation.setSender(sender);
    client.closeDictation.mockResolvedValue({ success: true, data: { text: '', latencyMs: 5 } });
    await dictation.start();
    await dictation.finish();
    expect(dictation.phase).toBe('idle');

    await dictation.start();
    await vi.waitFor(() => expect(client.openDictation).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    dictation.cancel();
    expect(dictation.phase).toBe('idle');
    await vi.waitFor(() => expect(client.abortStream).toHaveBeenCalledWith({ streamId: 's1' }));
    expect(sender).not.toHaveBeenCalled();
    dictation.dispose();
  });

  it('does not open over a command the microphone is already taking', async () => {
    const dictation = store(true);
    await dictation.start();
    expect(dictation.phase).toBe('idle');
    expect(client.openDictation).not.toHaveBeenCalled();
    dictation.dispose();
  });
});
