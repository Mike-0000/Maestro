import { describe, expect, it } from 'vitest';
import { guessDeviceName } from './device-name';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const ANDROID_REDUCED =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/126.0.0.0`;
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

describe('guessDeviceName', () => {
  it('names Apple devices', () => {
    expect(guessDeviceName(IPHONE, 5)).toBe('iPhone');
    expect(guessDeviceName(IPAD_DESKTOP_UA, 5)).toBe('iPad');
    expect(guessDeviceName(IPAD_DESKTOP_UA, 0)).toBe('Safari on Mac');
  });

  it('uses the Android model when the user agent still carries one', () => {
    expect(guessDeviceName(PIXEL, 5)).toBe('Pixel 8');
    expect(guessDeviceName(ANDROID_REDUCED, 5)).toBe('Android phone');
  });

  it('falls back to browser and operating system on desktops', () => {
    expect(guessDeviceName(CHROME_WINDOWS)).toBe('Chrome on Windows');
    expect(guessDeviceName(EDGE_WINDOWS)).toBe('Edge on Windows');
    expect(guessDeviceName(FIREFOX_LINUX)).toBe('Firefox on Linux');
    expect(guessDeviceName('')).toBe('Browser');
  });
});
