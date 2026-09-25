import { describe, expect, it } from 'vitest';
import { BrowserConsoleBuffer } from './browser-console-buffer';

describe('BrowserConsoleBuffer', () => {
  it('filters by level and returns the newest entries', () => {
    const buffer = new BrowserConsoleBuffer(() => 5);
    buffer.push('b1', { level: 'info', message: 'booted' });
    buffer.push('b1', { level: 'error', message: 'TypeError: x is undefined' });
    buffer.push('b1', { level: 'warning', message: 'deprecated' });
    expect(buffer.tail('b1', 10).map((entry) => entry.message)).toEqual([
      'TypeError: x is undefined',
      'deprecated',
    ]);
    expect(buffer.tail('b1', 1, 'info')).toEqual([
      { level: 'warning', message: 'deprecated', at: 5 },
    ]);
  });

  it('caps message length and history size', () => {
    const buffer = new BrowserConsoleBuffer();
    for (let index = 0; index < 250; index += 1) {
      buffer.push('b1', { level: 'error', message: `${index}:${'x'.repeat(1000)}` });
    }
    const all = buffer.tail('b1', 1000, 'debug');
    expect(all).toHaveLength(200);
    expect(all[0]?.message.startsWith('50:')).toBe(true);
    expect(all[0]?.message.length).toBeLessThanOrEqual(501);
  });

  it('forgets a browser', () => {
    const buffer = new BrowserConsoleBuffer();
    buffer.push('b1', { level: 'error', message: 'boom' });
    buffer.forget('b1');
    expect(buffer.tail('b1')).toEqual([]);
  });
});
