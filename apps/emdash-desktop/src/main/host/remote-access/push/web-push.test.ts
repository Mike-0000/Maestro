import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createPushSender,
  encryptPayload,
  generateVapidKeys,
  parsePushEndpoint,
  pushTopic,
  validSubscriptionKeys,
  vapidAuthorization,
  type PushSubscriptionKeys,
} from './web-push';

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz' +
    'AC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function subscription(overrides: Partial<PushSubscriptionKeys> = {}): PushSubscriptionKeys {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: RFC.p256dh,
    auth: RFC.auth,
    ...overrides,
  };
}

describe('encryptPayload', () => {
  it('reproduces the RFC 8291 example', () => {
    const body = encryptPayload(subscription(), Buffer.from(RFC.plaintext), {
      salt: Buffer.from(RFC.salt, 'base64url'),
      privateKey: Buffer.from(RFC.asPrivate, 'base64url'),
    });
    expect(body.toString('base64url')).toBe(RFC.body);
  });

  it('uses a fresh salt and key for every message', () => {
    const first = encryptPayload(subscription(), Buffer.from('same'));
    const second = encryptPayload(subscription(), Buffer.from('same'));
    expect(first.equals(second)).toBe(false);
  });
});

describe('vapidAuthorization', () => {
  it('signs a short-lived token for the push service that the public key verifies', () => {
    const vapid = generateVapidKeys();
    const now = 1_700_000_000_000;
    const header = vapidAuthorization(vapid, 'https://fcm.googleapis.com', now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(header);
    if (!match) throw new Error(`Unexpected header: ${header}`);
    const [, head, claims, signature, key] = match;

    expect(key).toBe(vapid.publicKey);
    expect(Buffer.from(vapid.publicKey, 'base64url')).toHaveLength(65);
    expect(JSON.parse(Buffer.from(head ?? '', 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    const parsed = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(parsed.aud).toBe('https://fcm.googleapis.com');
    expect(parsed.exp).toBe(now / 1000 + 12 * 60 * 60);
    expect(parsed.sub).toMatch(/^mailto:/u);

    const { d: _d, ...publicJwk } = vapid.privateJwk;
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature ?? '', 'base64url')
      )
    ).toBe(true);
  });
});

describe('parsePushEndpoint', () => {
  it('accepts only the supported push service over https', () => {
    expect(parsePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')?.pathname).toBe(
      '/fcm/send/abc'
    );
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/fcm/send/abc',
      'https://evil.example/fcm.googleapis.com',
      'https://127.0.0.1/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'not a url',
    ]) {
      expect(parsePushEndpoint(endpoint), endpoint).toBeNull();
    }
  });
});

describe('validSubscriptionKeys', () => {
  it('checks the key sizes', () => {
    expect(validSubscriptionKeys(RFC.p256dh, RFC.auth)).toBe(true);
    expect(validSubscriptionKeys(RFC.auth, RFC.auth)).toBe(false);
    expect(validSubscriptionKeys(RFC.p256dh, RFC.p256dh)).toBe(false);
    expect(validSubscriptionKeys('', '')).toBe(false);
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString(
      'base64url'
    );
    expect(validSubscriptionKeys(offCurve, RFC.auth)).toBe(false);
  });
});

describe('createPushSender', () => {
  const vapid = generateVapidKeys();

  function sender(response: Response | Error) {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    return {
      send: createPushSender({ fetch: fetchMock, now: () => 1_700_000_000_000 }),
      fetchMock,
    };
  }

  it('posts an encrypted, signed, urgent message', async () => {
    const { send, fetchMock } = sender(new Response(null, { status: 201 }));
    const result = await send(vapid, subscription(), {
      payload: '{"v":1}',
      topic: pushTopic('conversation:1'),
    });

    expect(result).toEqual({ outcome: 'sent' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/u);
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('600');
    expect(headers.Urgency).toBe('high');
    expect(headers.Topic).toHaveLength(32);
    expect(Buffer.from(init?.body as Uint8Array).includes('{"v":1}')).toBe(false);
  });

  it('reports a subscription that is gone or was made with another key', async () => {
    for (const status of [404, 410, 403]) {
      const { send } = sender(new Response(null, { status }));
      expect(await send(vapid, subscription(), { payload: 'x' })).toEqual({
        outcome: 'gone',
        status,
      });
    }
  });

  it('asks for a retry only when the service says it refused the message', async () => {
    const throttled = sender(new Response(null, { status: 429, headers: { 'Retry-After': '7' } }));
    expect(await throttled.send(vapid, subscription(), { payload: 'x' })).toEqual({
      outcome: 'retry',
      status: 429,
      retryAfterMs: 7000,
    });

    const slow = sender(new Response(null, { status: 503, headers: { 'Retry-After': '9999' } }));
    expect(await slow.send(vapid, subscription(), { payload: 'x' })).toEqual({
      outcome: 'retry',
      status: 503,
      retryAfterMs: 60_000,
    });

    const timedOut = sender(new Error('timeout'));
    expect(await timedOut.send(vapid, subscription(), { payload: 'x' })).toEqual({
      outcome: 'failed',
    });

    const rejected = sender(new Response(null, { status: 400 }));
    expect(await rejected.send(vapid, subscription(), { payload: 'x' })).toEqual({
      outcome: 'failed',
      status: 400,
    });
  });

  it('never contacts an endpoint outside the supported push service', async () => {
    const { send, fetchMock } = sender(new Response(null, { status: 201 }));
    const result = await send(vapid, subscription({ endpoint: 'https://evil.example/push' }), {
      payload: 'x',
    });
    expect(result).toEqual({ outcome: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a payload too large for one push message', async () => {
    const { send, fetchMock } = sender(new Response(null, { status: 201 }));
    expect(await send(vapid, subscription(), { payload: 'x'.repeat(3001) })).toEqual({
      outcome: 'failed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
