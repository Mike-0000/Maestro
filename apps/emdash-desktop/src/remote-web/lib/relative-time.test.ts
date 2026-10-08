import { describe, expect, it } from 'vitest';
import { describeRelativeTime, formatRelativeTime } from './relative-time';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const ago = (ms: number): number => NOW - ms;

describe('formatRelativeTime', () => {
  it('formats recent activity compactly', () => {
    expect(formatRelativeTime(ago(5_000), NOW)).toBe('now');
    expect(formatRelativeTime(ago(50_000), NOW)).toBe('1m');
    expect(formatRelativeTime(ago(4 * 60_000), NOW)).toBe('4m');
    expect(formatRelativeTime(ago(3 * 3_600_000 + 10), NOW)).toBe('3h');
    expect(formatRelativeTime(ago(2 * 86_400_000), NOW)).toBe('2d');
  });

  it('is empty when the host has seen no activity', () => {
    expect(formatRelativeTime(null, NOW)).toBe('');
  });

  it('treats timestamps from a fast host clock as now', () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('now');
  });

  it('has a spoken form', () => {
    expect(describeRelativeTime(ago(60_000), NOW)).toBe('1 minute ago');
    expect(describeRelativeTime(ago(2 * 3_600_000), NOW)).toBe('2 hours ago');
    expect(describeRelativeTime(null, NOW)).toBe('no activity yet');
  });
});
