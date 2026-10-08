import { describe, expect, it } from 'vitest';
import { createReconnectSchedule, reconnectDelayMs } from './backoff';

const noJitter = (): number => 0.5;

describe('reconnect backoff', () => {
  it('grows from a fast first retry to a steady ceiling', () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map((attempt) => reconnectDelayMs(attempt, noJitter));
    expect(delays).toEqual([300, 600, 1200, 2500, 5000, 5000, 5000]);
  });

  it('keeps jitter within twenty percent either side', () => {
    expect(reconnectDelayMs(4, () => 0)).toBe(4000);
    expect(reconnectDelayMs(4, () => 1)).toBe(6000);
  });

  it('treats nonsense attempt numbers as the first attempt', () => {
    expect(reconnectDelayMs(-3, noJitter)).toBe(300);
  });

  it('never exhausts', () => {
    const schedule = createReconnectSchedule(noJitter);
    expect(schedule.delayFor(0)).toBe(300);
    expect(schedule.delayFor(10_000)).toBe(5000);
  });
});
