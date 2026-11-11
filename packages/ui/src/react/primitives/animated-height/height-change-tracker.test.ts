import { describe, expect, it } from 'vitest';
import { createHeightChangeTracker } from './height-change-tracker';

describe('createHeightChangeTracker', () => {
  it('ignores a first observation that matches the initial measurement', () => {
    const tracker = createHeightChangeTracker(100);
    expect(tracker.observe(100)).toBeNull();
  });

  it('signals a first observation that differs from the initial measurement', () => {
    // The content changed between the synchronous measurement and the first
    // ResizeObserver callback; swallowing it would leave the box stuck at the
    // stale height.
    const tracker = createHeightChangeTracker(100);
    expect(tracker.observe(240)).toBe(240);
    expect(tracker.observe(240)).toBeNull();
  });

  it('signals a change after the first observation', () => {
    const tracker = createHeightChangeTracker(100);
    tracker.observe(100);
    expect(tracker.observe(180)).toBe(180);
  });

  it('ignores observations equal to the last known height', () => {
    const tracker = createHeightChangeTracker(100);
    tracker.observe(100);
    expect(tracker.observe(100)).toBeNull();
  });

  it('tracks the latest signalled height for dedupe', () => {
    const tracker = createHeightChangeTracker(100);
    tracker.observe(100);
    expect(tracker.observe(150)).toBe(150);
    expect(tracker.observe(150)).toBeNull();
    expect(tracker.observe(100)).toBe(100);
  });

  it('handles an unknown initial height', () => {
    const tracker = createHeightChangeTracker(undefined);
    expect(tracker.observe(50)).toBeNull();
    expect(tracker.observe(50)).toBeNull();
    expect(tracker.observe(80)).toBe(80);
  });
});
