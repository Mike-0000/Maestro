import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

// Web Push without a relay or a vendor SDK: the payload is encrypted to the browser's
// subscription keys (RFC 8291, `aes128gcm`) and the request is signed with this host's own
// VAPID key (RFC 8292). The browser's push service only ever sees ciphertext.

/** The only push service a subscription may point at: Chrome's, on Android and desktop. */
const PUSH_SERVICE_HOST = 'fcm.googleapis.com';
const CURVE = 'prime256v1';
const PUBLIC_KEY_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
const RECORD_SIZE = 4096;
/** The push service rejects bodies over 4096 bytes; the header and tag take 102 of them. */
export const MAX_PUSH_PLAINTEXT_BYTES = 3000;
const JWT_LIFETIME_MS = 12 * 60 * 60 * 1000;
const JWT_REFRESH_MARGIN_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
/** A completion that arrives more than ten minutes late is noise. */
const TTL_SECONDS = 600;
const VAPID_SUBJECT = 'mailto:notifications@maestro.invalid';

export type VapidPrivateJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };

export type VapidKeys = {
  /** The uncompressed public point, base64url: what the browser subscribes with. */
  publicKey: string;
  privateJwk: VapidPrivateJwk;
};

export type PushSubscriptionKeys = {
  endpoint: string;
  /** The browser's public key, base64url (65 bytes). */
  p256dh: string;
  /** The subscription's shared secret, base64url (16 bytes). */
  auth: string;
};

export type PushMessage = {
  payload: string;
  /** Messages with the same topic replace one another while still undelivered. */
  topic?: string;
};

export type PushSendResult =
  | { outcome: 'sent' }
  /** The subscription no longer exists, or was made with another VAPID key. */
  | { outcome: 'gone'; status: number }
  | { outcome: 'retry'; status: number; retryAfterMs: number }
  | { outcome: 'failed'; status?: number };

export type PushSender = (
  vapid: VapidKeys,
  subscription: PushSubscriptionKeys,
  message: PushMessage
) => Promise<PushSendResult>;

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error('Generated VAPID key is incomplete');
  const privateJwk: VapidPrivateJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
  return { publicKey: vapidPublicKey(privateJwk), privateJwk };
}

export function vapidPublicKey(jwk: VapidPrivateJwk): string {
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
}

/** The `Authorization` header that proves a push request comes from this host. */
export function vapidAuthorization(vapid: VapidKeys, audience: string, now: number): string {
  const header = encodeJson({ typ: 'JWT', alg: 'ES256' });
  const claims = encodeJson({
    aud: audience,
    exp: Math.floor((now + JWT_LIFETIME_MS) / 1000),
    sub: VAPID_SUBJECT,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey({ key: vapid.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${signature.toString('base64url')}, k=${vapid.publicKey}`;
}

/**
 * Encrypts one message for a subscription. `random` fixes the values that are otherwise fresh
 * for every message, so a published test vector can be reproduced.
 */
export function encryptPayload(
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  plaintext: Buffer,
  random: { salt: Buffer; privateKey: Buffer } = {
    salt: randomBytes(16),
    privateKey: Buffer.alloc(0),
  }
): Buffer {
  const uaPublic = Buffer.from(subscription.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.auth, 'base64url');
  const ecdh = createECDH(CURVE);
  if (random.privateKey.byteLength > 0) ecdh.setPrivateKey(random.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, secret, keyInfo, 32);
  const key = hkdf(random.salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(random.salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // 0x02 marks the last (here, only) record.
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.update(Buffer.from([0x02])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  random.salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.byteLength, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** The endpoint as a URL when it names the supported push service, otherwise null. */
export function parsePushEndpoint(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== PUSH_SERVICE_HOST) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  return url;
}

/** True when the keys are ones a message can be encrypted to. */
export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  const publicKey = Buffer.from(p256dh, 'base64url');
  if (
    publicKey.byteLength !== PUBLIC_KEY_BYTES ||
    publicKey[0] !== 0x04 ||
    Buffer.from(auth, 'base64url').byteLength !== AUTH_SECRET_BYTES
  ) {
    return false;
  }
  try {
    // Rejects a point that is not on the curve.
    const ecdh = createECDH(CURVE);
    ecdh.generateKeys();
    ecdh.computeSecret(publicKey);
    return true;
  } catch {
    return false;
  }
}

export function pushTopic(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}

export function createPushSender(
  options: { fetch?: typeof fetch; now?: () => number } = {}
): PushSender {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const authorizations = new Map<string, { value: string; expiresAt: number }>();

  function authorizationFor(vapid: VapidKeys, audience: string): string {
    const cacheKey = `${vapid.publicKey} ${audience}`;
    const cached = authorizations.get(cacheKey);
    if (cached && cached.expiresAt - JWT_REFRESH_MARGIN_MS > now()) return cached.value;
    const value = vapidAuthorization(vapid, audience, now());
    authorizations.set(cacheKey, { value, expiresAt: now() + JWT_LIFETIME_MS });
    return value;
  }

  return async (vapid, subscription, message) => {
    const endpoint = parsePushEndpoint(subscription.endpoint);
    const plaintext = Buffer.from(message.payload, 'utf8');
    if (
      !endpoint ||
      !validSubscriptionKeys(subscription.p256dh, subscription.auth) ||
      plaintext.byteLength > MAX_PUSH_PLAINTEXT_BYTES
    ) {
      return { outcome: 'failed' };
    }

    let response: Response;
    try {
      response = await send(endpoint, {
        method: 'POST',
        // The endpoint was chosen by the push service; it must not send us anywhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          Authorization: authorizationFor(vapid, endpoint.origin),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL_SECONDS),
          // Without this the message waits for the phone's next maintenance window.
          Urgency: 'high',
          ...(message.topic ? { Topic: message.topic } : {}),
        },
        body: new Uint8Array(encryptPayload(subscription, plaintext)),
      });
    } catch {
      // A timeout may still have been accepted, so it is never sent again.
      return { outcome: 'failed' };
    }

    const { status } = response;
    void response.body?.cancel().catch(() => {});
    if (status >= 200 && status < 300) return { outcome: 'sent' };
    if (status === 404 || status === 410 || status === 403) return { outcome: 'gone', status };
    if (status === 429 || status >= 500) {
      return {
        outcome: 'retry',
        status,
        retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), now()),
      };
    }
    return { outcome: 'failed', status };
  };
}

function retryAfterMs(header: string | null, now: number): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(delay) || delay <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
