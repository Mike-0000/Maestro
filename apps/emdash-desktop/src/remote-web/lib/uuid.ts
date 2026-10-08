type UuidString = ReturnType<Crypto['randomUUID']>;

/** An RFC 4122 version 4 UUID from `crypto.getRandomValues`, which every origin has. */
function uuidFromRandomValues(): UuidString {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomUuid(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidFromRandomValues();
}

/**
 * Browsers expose `crypto.randomUUID` on secure origins only, and the Wire runtime calls it for
 * every request. Opened over plain http on a local network the app would otherwise fail before
 * it could say anything, including that the microphone needs https. Call once at startup.
 */
export function installRandomUuidFallback(): void {
  if (typeof crypto.randomUUID === 'function') return;
  Object.defineProperty(crypto, 'randomUUID', {
    value: uuidFromRandomValues,
    configurable: true,
    writable: true,
  });
}
