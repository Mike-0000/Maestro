import { describe, expect, it } from 'vitest';
import { TurnDetector } from './turn-detector';

const CHUNK_MS = 50;

function feed(detector: TurnDetector, level: number, ms: number): (string | null)[] {
  const edges: (string | null)[] = [];
  for (let at = 0; at < ms; at += CHUNK_MS) edges.push(detector.push(level, CHUNK_MS));
  return edges.filter((edge) => edge !== null);
}

describe('TurnDetector', () => {
  it('finds speech after a moment of it, and its end after a pause', () => {
    const detector = new TurnDetector();
    expect(feed(detector, 0.001, 1_000)).toEqual([]);
    expect(feed(detector, 0.2, 50)).toEqual([]);
    expect(feed(detector, 0.2, 50)).toEqual(['start']);
    expect(detector.speaking).toBe(true);
    // A breath is not the end of a sentence.
    expect(feed(detector, 0.001, 400)).toEqual([]);
    expect(feed(detector, 0.2, 500)).toEqual([]);
    expect(feed(detector, 0.001, 700)).toEqual(['stop']);
    expect(detector.speaking).toBe(false);
  });

  it('does not take a click or a cough for speech', () => {
    const detector = new TurnDetector();
    for (let i = 0; i < 10; i++) {
      expect(feed(detector, 0.3, 50)).toEqual([]);
      expect(feed(detector, 0.001, 200)).toEqual([]);
    }
  });

  it('follows the noise of the room, so a steady hum is not speech', () => {
    const detector = new TurnDetector();
    // Loud enough to be speech in a quiet room.
    expect(feed(detector, 0.035, 100)).toEqual(['start']);
    detector.reset();
    // Once a fan's hum is learned, the same level is not.
    feed(detector, 0.015, 5_000);
    expect(feed(detector, 0.035, 1_000)).toEqual([]);
    expect(feed(detector, 0.2, 100)).toEqual(['start']);
  });

  it('cuts endless sound into turns', () => {
    const detector = new TurnDetector({
      startMs: 100,
      stopMs: 700,
      maxMs: 1_000,
      minLevel: 0.02,
      floorRatio: 3,
    });
    expect(feed(detector, 0.2, 1_000)).toEqual(['start', 'stop']);
  });
});
