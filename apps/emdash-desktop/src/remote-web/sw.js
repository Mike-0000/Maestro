// Service worker for the Maestro web client. A build template: remote-web.vite.config.ts
// replaces the manifest placeholder below with the list of built shell files and emits the
// result as /sw.js, so this file's bytes change with every build.
//
// It caches the app shell — and only the shell — so the installed app opens instantly and
// offline shows its own "reconnecting" state instead of a browser error page. Everything live
// (/api, /wire) always goes to the network and is never stored.

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
