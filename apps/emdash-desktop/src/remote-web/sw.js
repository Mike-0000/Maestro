// Service worker for the Maestro web client. A build template: remote-web.vite.config.ts
// replaces the manifest placeholder below with the list of built shell files and emits the
// result as /sw.js, so this file's bytes change with every build.
//
// It caches the app shell — and only the shell — so the installed app opens instantly and
// offline shows its own "reconnecting" state instead of a browser error page. Everything live
// (/api, /wire) always goes to the network and is never stored.
//
// It also shows the notifications the host pushes when an agent finishes or needs input, which
// is the one thing that reaches this device while the app is closed.

const SHELL_FILES = /*__PRECACHE_MANIFEST__*/ [];
const CACHE_PREFIX = 'maestro-shell-';
const CACHE_NAME = CACHE_PREFIX + hash(SHELL_FILES.join('|'));
const SHELL_URL = '/';

function hash(text) {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) {
    value = ((value << 5) + value + text.charCodeAt(index)) >>> 0;
  }
  return value.toString(36);
}

function isLive(url) {
  return (
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/wire' ||
    url.pathname.startsWith('/wire/')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(SHELL_FILES.map((file) => new Request(file, { cache: 'reload' })))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isLive(url)) return;

  // Every in-app URL (/, /agent/…) is the same document, answered from the cached shell. The
  // cached document and its assets always come from one build; a newer build arrives as a new
  // worker with its own cache and takes over on the next launch.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(SHELL_URL))
        .then((cached) => cached ?? fetch(request))
    );
    return;
  }

  // Built assets are content-hashed and icons rarely change: cache first, then network.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (
        response.ok &&
        (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))
      ) {
        void cache.put(request, response.clone());
      }
      return response;
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    const parsed = event.data ? event.data.json() : null;
    if (typeof parsed === 'object' && parsed !== null) data = parsed;
  } catch {
    // Fall through to the generic notification: the browser requires one for every push.
  }
  const text = (value, fallback) => (typeof value === 'string' && value ? value : fallback);
  event.waitUntil(
    self.registration.showNotification(text(data.title, 'Maestro'), {
      body: text(data.body, 'An agent needs a look.'),
      // One card per conversation: a newer event replaces the older one and alerts again.
      tag: text(data.tag, 'maestro'),
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { path: agentPath(data.url) },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = agentPath(event.notification.data && event.notification.data.path);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(path);
      // The running app routes in place, which keeps its connection and avoids a reload.
      open.postMessage({ type: 'maestro:navigate', path });
      return open.focus();
    })
  );
});

/** A pushed link may only ever lead to one of this app's agent screens. */
function agentPath(value) {
  return typeof value === 'string' && /^\/agent\/[^/?#]+$/.test(value) ? value : '/';
}
