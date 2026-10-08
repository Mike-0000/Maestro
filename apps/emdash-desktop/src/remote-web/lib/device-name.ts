/**
 * A sensible default name for this device, shown in the host's list of paired devices:
 * the device itself where the user agent names it ("iPhone", "Pixel 8"), otherwise the
 * browser and operating system ("Chrome on Windows").
 */
export function guessDeviceName(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPod/.test(ua)) return 'iPod touch';
  // iPadOS reports a Mac user agent; only the touch screen tells them apart.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'iPad';

  if (/Android/.test(ua)) {
    const model = androidModel(ua);
    if (model) return model;
    return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  }

  const browser = browserName(ua);
  const os = osName(ua);
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Browser';
}

function androidModel(ua: string): string | undefined {
  const match = /Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(ua);
  const model = match?.[1]?.trim();
  // Chrome's reduced user agent replaces the model with the letter K.
  if (!model || model === 'K' || /^(wv|Mobile|Tablet|rv:[\d.]+)$/i.test(model)) return undefined;
  return model;
}

function browserName(ua: string): string | undefined {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return undefined;
}

function osName(ua: string): string | undefined {
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return undefined;
}
