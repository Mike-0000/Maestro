import { describe, expect, it } from 'vitest';
import { deepgramStreamUrl, TranscriptAccumulator } from './deepgram-stream';

describe('deepgramStreamUrl', () => {
  it('requests 16 kHz linear16 with interim results and keyterms', () => {
    const url = new URL(
      deepgramStreamUrl({ language: 'en', vocabulary: ['Claude 1', 'Claude 1', ' '] })
    );
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.getAll('keyterm')).toEqual(['Claude 1']);
  });
});

describe('TranscriptAccumulator', () => {
  const result = (transcript: string, isFinal: boolean, confidence?: number) => ({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript, confidence }] },
  });

  it('shows interim text after finals and keeps only finals at the end', () => {
    const acc = new TranscriptAccumulator();
    expect(acc.apply(result('tell', false))).toBe(true);
    expect(acc.text).toBe('tell');
    acc.apply(result('tell codex', true, 0.87));
    expect(acc.confidence).toBe(0.87);
    acc.apply(result('to run', false, 0.45));
    expect(acc.confidence).toBe(0.45);
    expect(acc.finalConfidence).toBe(0.87);
    expect(acc.text).toBe('tell codex to run');
    acc.apply(result('to run the tests', true));
    expect(acc.finalText).toBe('tell codex to run the tests');
    expect(acc.apply({ type: 'Metadata' })).toBe(false);
  });

  it('falls back to the interim tail when nothing was finalized', () => {
    const acc = new TranscriptAccumulator();
    acc.apply(result('show all', false));
    expect(acc.finalText).toBe('show all');
  });
});
