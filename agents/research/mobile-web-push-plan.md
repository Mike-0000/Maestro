# Mobile Web Push Plan

Status: Implemented 2026-10-08, not yet verified on a phone (see the
[on-device checklist](#on-device-checklist-pixel-9-pro-chrome)). Targets one platform:
**Chrome on Android, installed as a PWA** (Pixel 9 Pro). iOS, Edge, Firefox, and multi-window
reconciliation are out of scope and listed under [Deferred](#deferred).

Differences from the plan below: the sink and its queue live in `push/push-dispatcher.ts`
(not `push-sink.ts`), and a device that is no longer paired is forgotten the next time a
notification would have gone to it, rather than through a separate prune call.

## What this delivers

When an agent finishes or starts waiting for input, the phone shows an Android notification
even when the Maestro PWA is closed. Tapping it opens the PWA on that agent.

How it works: the PWA's service worker subscribes to Chrome's push service (FCM) and hands the
subscription to the desktop host. When the host's notification service fires, the host
encrypts a small payload for that subscription and POSTs it to `fcm.googleapis.com`. FCM wakes
Chrome, Chrome wakes the service worker, the worker shows the notification. No Firebase
project, no relay server, no native app: the host signs each request with its own VAPID key.

Limits that do not go away:

- The desktop app must be running and online to notice the event and send the push.
- The phone needs a secure origin to subscribe at all, so the PWA must be opened through the
  HTTPS name (Tailscale Serve or a tunnel), never `http://<lan-ip>:7462`.
- The push arrives without the tunnel; the tap only opens the app when the phone can reach the
  host (on the tailnet, for Tailscale Serve).
- A push subscription belongs to one origin. A new HTTPS name means pairing and enabling again.
- Force-stopping Chrome, or turning its notifications off in Android settings, stops delivery.

## What exists today (verified in the code)

| Piece | Where | State |
| --- | --- | --- |
| PWA manifest, `display: standalone`, `id`/`scope` `/` | `src/remote-web/public/manifest.webmanifest` | Ready, no change |
| Service worker, production builds only | `src/remote-web/sw.js`, `lib/service-worker.ts` | Shell cache only; no `push` or `notificationclick` |
| Remote listener with a `routes` hook tried before built-in routes | `src/main/host/remote-access/http-server.ts` | Ready; cookie auth and origin checks are private functions |
| Paired device store (`remote-access.json`, "holds no secrets") | `src/main/host/remote-access/device-store.ts` | Do not put push keys here |
| Encrypted key/value secrets (`getSecret`/`setSecret`/`deleteSecret`) | `src/main/host/secrets/encrypted-app-secrets-store.ts` | Ready; existing `appSecrets` table, no migration |
| Agent events mapped to `agent-complete` / `agent-attention` with `target.conversationId` | `src/core/services/notifications/node/producers/agent-status-mapping.ts` | Ready |
| Two-second per-conversation batch, then sinks | `NotificationService.flush` in `notification-service.ts` | Delivers only to `system` and `sound`, each gated by the desktop routing decision |
| Phone route for one agent | `/agent/<conversationId>` in `src/remote-web/state/router.ts` | Ready |
| Any push code (`web-push`, VAPID, `PushManager`) | whole repo | None |

All app paths below are relative to `apps/emdash-desktop/`.

## Decisions

1. **No new dependency.** The sender is about 150 lines of `node:crypto` plus global `fetch`
   (Node 24). The `web-push` package would add a dependency tree for two RFCs we can test
   against published vectors. AGENTS.md prefers the existing stack.
2. **One subscription per paired device.** A phone has one PWA. Re-subscribing replaces the
   record. This removes endpoint hashing, ownership checks, and shared-registration handling.
3. **Everything push-related is a secret.** The VAPID private key and each subscription
   (the endpoint is a capability URL; `auth` is a shared secret) go in
   `EncryptedAppSecretsStore`, not in `remote-access.json`.
4. **Only `fcm.googleapis.com` endpoints are accepted.** The host never POSTs to a URL a client
   picked freely.
5. **The phone gets the same title and body as the desktop banner.** The payload is encrypted
   end to end to the phone, and the lock screen is the user's own. The body is capped at 300
   characters.
6. **Phone push ignores desktop focus and the desktop OS-banner and sound toggles.** It obeys
   the global `notifications.enabled` switch, Remote Access being enabled, and the device's own
   two event toggles.
7. **One send attempt, one retry.** Retry once on 429 or 5xx (honouring `Retry-After`, capped
   at 60 s). Never retry a timeout. Delete the subscription on 404, 410, or 403.

## Wire format reference

### VAPID (RFC 8292)

- Key pair: `generateKeyPairSync('ec', { namedCurve: 'prime256v1' })`, generated once.
- Public key for the browser and the header: 65 raw bytes `0x04 || x || y` (from the JWK `x`
  and `y`), base64url without padding. This is `applicationServerKey`.
- JWT header `{"typ":"JWT","alg":"ES256"}`; claims
  `{"aud":"https://fcm.googleapis.com","exp":<now + 12h, seconds>,"sub":"mailto:<contact>"}`.
  `aud` is the origin of the subscription endpoint. `exp` must be under 24 hours.
- Signature: `crypto.sign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' })`
  (raw 64-byte `r || s`, not DER).
- Request header: `Authorization: vapid t=<jwt>, k=<public key base64url>`.
- Cache the JWT per audience and reuse it until an hour before `exp`.

### Payload encryption (RFC 8291, `aes128gcm`)

Inputs: `uaPublic` (subscription `p256dh`, 65 bytes), `authSecret` (subscription `auth`,
16 bytes), plaintext.

```text
as            = createECDH('prime256v1'); as.generateKeys()      // fresh per message
asPublic      = as.getPublicKey()                                 // 65 bytes
ecdhSecret    = as.computeSecret(uaPublic)
salt          = randomBytes(16)
ikm           = HKDF-SHA256(salt = authSecret, ikm = ecdhSecret,
                            info = "WebPush: info\0" || uaPublic || asPublic, len = 32)
cek           = HKDF-SHA256(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
nonce         = HKDF-SHA256(salt, ikm, "Content-Encoding: nonce\0", 12)
ciphertext    = AES-128-GCM(cek, nonce, plaintext || 0x02)        // 0x02 = last record
body          = salt(16) || uint32be(4096) || uint8(65) || asPublic(65) || ciphertext || tag(16)
```

Use `crypto.hkdfSync('sha256', ikm, salt, info, length)` (note the argument order: key first,
then salt). Keep plaintext under 3,000 bytes; FCM rejects bodies over 4,096.

### The request

```text
POST <subscription.endpoint>
Authorization: vapid t=<jwt>, k=<vapid public key>
Content-Encoding: aes128gcm
Content-Type: application/octet-stream
TTL: 600
Urgency: high
Topic: <first 32 base64url chars of sha256(groupKey)>
```

- `Urgency: high` is what lets the message through Android Doze; without it delivery waits for
  a maintenance window.
- `Topic` makes FCM replace an undelivered older message for the same conversation.
- `TTL: 600`: a completion that is ten minutes late is noise.
- Call `fetch` with `redirect: 'error'` and `AbortSignal.timeout(10_000)`.
- `201` is success. `404`/`410` mean the subscription is gone. `403` means the VAPID key does
  not match the one the subscription was created with. `413` means the body is too large.

### Plaintext payload

```json
{ "v": 1, "title": "Claude - fix login", "body": "Your agent has finished working",
  "tag": "conversation:<id>", "url": "/agent/<id>" }
```

## Implementation

### 1. Sender: `src/main/host/remote-access/push/web-push.ts` (new)

Pure functions, no I/O except the injected `fetch`:

- `generateVapidKeys(): { publicKey: string; privateJwk: JsonWebKey }`
- `vapidAuthorization(keys, audience, now): string`
- `encryptPayload(subscription, plaintext, random?): Buffer` — `random` supplies the salt and
  ephemeral key so the RFC vector can be reproduced in tests.
- `parsePushEndpoint(value): URL | null` — accepts only `https:`, host exactly
  `fcm.googleapis.com`, no userinfo, default port.
- `sendPush(deps, subscription, payload): Promise<'sent' | 'gone' | 'retry' | 'failed'>`

Test file `web-push.test.ts`: the RFC 8291 Appendix A vector for encryption, a JWT that
verifies against the public key with `crypto.verify`, endpoint parsing (rejects other hosts,
`http:`, userinfo, ports, IP literals), and status mapping with a fake `fetch`.

### 2. Store: `src/main/host/remote-access/push/push-store.ts` (new)

Depends on a narrow port `{ getSecret, setSecret, deleteSecret }` so tests use an in-memory
fake and need no SQLite. Two keys:

- `remote-access.push.vapid` — `{ version: 1, publicKey, privateJwk }`
- `remote-access.push.subscriptions` — `{ version: 1, byDevice: { [deviceId]: { endpoint,
  p256dh, auth, events: { complete, attention }, updatedAt } } }`

Behaviour:

- `vapid()` loads the key pair or generates and saves it. If secure storage throws, the store
  reports `unavailable` and the feature is off; it never falls back to an in-memory key.
- All writes go through one promise chain (same pattern as `RemoteDeviceStore.persist`).
- `upsert(deviceId, record)`, `remove(deviceId)`, `get(deviceId)`, `all()`.
- `pruneTo(deviceIds)` drops records for devices that are no longer paired.
- Validate with zod on read; an unreadable subscriptions blob is treated as empty.
- Never log endpoints, keys, or payloads; log device id and HTTP status only.

### 3. HTTP routes: `src/main/host/remote-access/push/push-route.ts` (new)

A `RemoteAccessRoute` (same shape as `trigger-route.ts`) that claims `/api/push` and
`/api/push/*`. `http-server.ts` already runs `routes` before its own `/api/` 404, so no change
to its dispatch. It does need three private helpers exported: `readCookie` with the
`SESSION_COOKIE` name (or one `authenticateRequest(store, request)`), `sameOrigin`, and
`readJsonBody`/`sendJson`.

Every route requires a cookie-authenticated device with `kind === 'browser'` (401 otherwise).
Every mutation also requires `sameOrigin(request)`: an `Origin` header that matches `Host`
(403 otherwise). The session cookie is already `SameSite=Strict`.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/push` | none | `{ available, publicKey, hostEnabled, subscription: { events } \| null }` |
| `PUT /api/push/subscription` | `{ endpoint, keys: { p256dh, auth }, events: { complete, attention } }` | `204`; `400 invalid-request`; `422 unsupported-push-service` |
| `DELETE /api/push/subscription` | none | `204` |
| `POST /api/push/test` | none | `{ ok: true }` or `{ ok: false, reason }`; `429` inside 5 s of the last test |

Validation on `PUT`: `endpoint` ≤ 1,024 chars and passes `parsePushEndpoint`; `p256dh`
decodes to 65 bytes starting `0x04`; `auth` decodes to 16 bytes. `hostEnabled` is false when
the global notifications switch is off, so the phone can say why nothing will arrive. The test
route sends to this device regardless of its event toggles and returns the mapped send result.

Tests `push-route.test.ts`: unauthenticated, desktop-kind device, missing or foreign `Origin`,
bad key lengths, non-FCM endpoint, upsert replaces, delete, test rate limit.

### 4. Dispatch

`src/core/services/notifications/api/routing.ts`: add `push: boolean` to `RoutingDecision`.

```ts
push: notification.kind === 'agent-complete' || notification.kind === 'agent-attention',
```

It stays `false` on the two early returns (notifications disabled, update kinds) and does not
read `appFocused`, `osNotifications`, or `sound`. Existing routing tests that compare the whole
decision object need the new field.

`notification-service.ts` `flush`: add a third branch and stop one sink's failure from
skipping the next.

```ts
if (decision.push) await this.deliverTo('mobile-push', deliveryBatch);
```

where `deliverTo` wraps `sink.deliver` in `try/catch` and logs through `deps.logger`.

`src/main/host/remote-access/push/push-sink.ts` (new): a `NotificationSink` with
`id: 'mobile-push'`. `deliver` returns immediately and does the network work in the
background so a slow FCM call never delays the desktop banner or sound. For each stored
subscription it:

1. skips when Remote Access is disabled, or drops the record when its device is no longer in
   `store.devices()` (this covers sign-out and revocation without touching those code paths);
2. picks the latest item in `batch.items` whose kind the device has switched on; skips the
   device when there is none;
3. builds the payload: `title` and `body` from that item (append ` (N notifications)` when
   the batch holds more than one), `tag` = `groupKey`, `url` = `/agent/<conversationId>` when
   `target.kind === 'task'` and it has a conversation id, else `/`;
4. calls `sendPush`; on `gone` removes the record; on `retry` waits and tries once more.

At most four sends run at a time. Queue depth is capped at 50; older entries are dropped.

Wiring:

- `RemoteAccessDependencies` gains `notifications: Pick<NotificationService, 'registerSink'>`
  and `secrets` (the port from step 2).
- `RemoteAccessService.attach` builds the push store and sink, registers the sink, and adds
  the unregister function to its `scope`. `startListener` adds `createPushRoute(...)` to
  `routes`.
- `src/main/bootstrap/boot/phases/gateway.ts` passes `getNotificationService()` and
  `encryptedAppSecretsStore` into `remoteAccessService.attach`.

Tests: `push-sink.test.ts` (event filtering, revoked device pruned, `gone` removes, Remote
Access disabled sends nothing, one retry only) and additions to the notification-service test
(push fires while the desktop app is focused; a throwing sink does not block the others).

### 5. Service worker: `src/remote-web/sw.js`

Append two listeners; leave the cache logic alone.

```js
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Fall through to the generic notification: Chrome requires one for every push.
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/agent/') ? data.url : '/';
  event.waitUntil(
    self.registration.showNotification(typeof data.title === 'string' ? data.title : 'Maestro', {
      body: typeof data.body === 'string' ? data.body : 'An agent needs a look.',
      tag: typeof data.tag === 'string' ? data.tag : 'maestro',
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (!open) return self.clients.openWindow(url);
      open.postMessage({ type: 'maestro:navigate', path: url });
      return open.focus();
    })
  );
});
```

Notes:

- Chrome enforces `userVisibleOnly`: every push must end in `showNotification`, or Chrome
  shows its own "site updated in the background" notice and may revoke the subscription.
  That is why a bad payload still shows a generic notification.
- `tag` + `renotify: true`: a second event for the same conversation replaces the first card
  and still buzzes.
- `badge` is the small status-bar icon. Android uses only its alpha channel, so it needs a new
  white-on-transparent `public/icons/badge-96.png`. The existing full-colour icon would render
  as a white square.
- With an open window, the worker posts a message instead of calling `client.navigate()`, so
  the app routes without a full reload. `lib/service-worker.ts` gets a
  `navigator.serviceWorker.addEventListener('message', …)` that validates the path with
  `parseRoute` and calls `router.push`.
- `openWindow` on an in-scope URL opens the installed PWA, not a Chrome tab.

### 6. Phone UI

`src/remote-web/lib/push-api.ts` (new), following `session-api.ts`: `fetchPushState`,
`savePushSubscription`, `removePushSubscription`, `sendTestPush`, with zod-parsed answers.

`src/remote-web/state/push-store.ts` (new), MobX, exposed through `app-context.ts` like the
voice store. State: `unsupported | host-unavailable | blocked | off | on`, plus
`events: { complete, attention }` and `busy`/`error`.

- `unsupported`: no `serviceWorker`, `PushManager`, or `Notification` in the page, or not a
  production build (the worker is only registered when `import.meta.env.PROD`).
- `blocked`: `Notification.permission === 'denied'`. Chrome will not ask again; the UI says to
  allow notifications for Maestro in Android settings.
- `enable()`, called straight from the tap handler:
  1. `await Notification.requestPermission()`; stop unless `'granted'`.
  2. `registration = await navigator.serviceWorker.ready`.
  3. If an existing subscription was made with a different key
     (`options.applicationServerKey` differs from the host's), `unsubscribe()` it first.
  4. `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
  5. `PUT /api/push/subscription` with `subscription.toJSON()` and the event toggles. If the
     host refuses, `unsubscribe()` and show the reason.
- `disable()`: `DELETE` on the host, then `subscription.unsubscribe()`.
- `sync()`, on app start and each time Settings opens: when permission is granted and a local
  subscription exists, `PUT` it again. The upsert is idempotent, so this heals a host that
  lost the record and a subscription Chrome rotated. When the host has a record and the
  browser has none, the store shows `off` and the next `enable()` replaces it.

`src/remote-web/ui/SettingsSheet.tsx`: a `Notifications` section above `Voice`, built from the
existing `ToggleRow`, `Switch`, and `Button`:

- **Notify this phone** — master switch, runs `enable()` / `disable()`.
- **Agent finished** and **Needs attention** — shown when on; each change re-`PUT`s.
- **Send test** — button; shows the host's answer when it fails.
- One line of status text for `unsupported`, `blocked`, `host-unavailable`, and "Notifications
  are turned off in Maestro on your computer" (`hostEnabled === false`).

Default on first enable: both events on.

### 7. Things that need no change

- CSP: `pushManager.subscribe` is not governed by `connect-src`.
- Manifest: already installable, with `id` and `scope` set.
- Database schema: none. Wire contract: none (the page uses plain same-origin HTTP, like
  pairing).
- Desktop settings UI: none in this pass.

## Build order

Each step is testable on its own.

1. `web-push.ts` and its tests (RFC vector passing is the gate).
2. `push-store.ts` and tests.
3. Export the three helpers from `http-server.ts`; `push-route.ts` and tests.
4. `routing.ts` + `flush` change + `push-sink.ts` and tests; wire into `attach` and
   `gateway.ts`.
5. `sw.js`, `service-worker.ts` message listener, badge icon.
6. `push-api.ts`, `push-store.ts`, `SettingsSheet.tsx`.
7. `pnpm run typecheck`, `pnpm run lint`, focused Vitest runs, then build the remote web app
   and confirm the emitted `out/remote-web/sw.js` contains both listeners.
8. Install the build and run the on-device checklist.

## On-device checklist (Pixel 9 Pro, Chrome)

Setup:

1. Desktop: Remote Access on, Tailscale Serve on. Phone: Tailscale connected.
2. Chrome on the phone: open `https://<machine>.<tailnet>.ts.net`, pair, then menu →
   **Add to Home screen** → **Install**.
3. Open Maestro from the home screen → Settings → **Notify this phone** → Allow.
4. **Send test**. A notification should arrive within a few seconds.

Verify:

- [ ] Test arrives with the PWA open, in the background, and swiped away from recents.
- [ ] Test arrives with the screen locked for 10+ minutes (Doze; proves `Urgency: high`).
- [ ] A real agent completion arrives; the title and body match the desktop banner.
- [ ] An agent waiting for input arrives; switching **Needs attention** off stops it.
- [ ] Tap with the PWA closed opens it on `/agent/<id>`; tap with it open routes in place.
- [ ] Two events for one conversation leave one card.
- [ ] Phone off the tailnet: the notification still arrives; the tap shows the app's own
      reconnecting state.
- [ ] Desktop app focused: the phone is still notified.
- [ ] Global notifications off on the desktop: nothing arrives, and Settings says why.
- [ ] Revoke the phone in desktop Remote Access: nothing arrives afterwards.
- [ ] Restart the desktop app: pushes still arrive without re-enabling (key persisted).
- [ ] Log the endpoint host once during development to confirm it is `fcm.googleapis.com`.

If nothing arrives: Android Settings → Apps → Maestro → Notifications must be on; the same
for Chrome; and Chrome must not be battery-restricted. `chrome://inspect` from desktop Chrome
shows the phone's service worker console.

## Risk notes for review

- New authenticated routes on the remote-access listener. They reuse the existing cookie and
  origin checks; nothing about pairing or Wire permissions changes.
- New outbound HTTPS from the main process, restricted to `fcm.googleapis.com`, redirects
  refused.
- New secrets in `appSecrets` through the existing encrypted store. No schema change.
- A change to `NotificationService.flush` and `RoutingDecision`, which the desktop banner and
  sound path share. The change adds a branch and isolates sink failures; desktop behaviour
  should be identical, and the existing tests cover it.
- No new dependency, no migration, no change to PTY, SSH, ACP, or the updater.

## Deferred

- iOS and iPadOS (Home Screen detection, APNs endpoints, permission guidance).
- Edge, Firefox, and Samsung Internet endpoints.
- More than one subscription per paired device; `BroadcastChannel` sync between windows.
- Recovery UI for a lost VAPID key (today: the next send gets 403, the record is dropped, and
  the phone shows `off` on its next sync).
- Not buzzing the phone while the user is active at the desktop.
- Showing push state per device in the desktop Remote Access settings.
- Agent error notifications (the producer does not map them yet).
