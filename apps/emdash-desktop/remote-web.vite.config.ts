import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The Maestro web client: a standalone PWA the desktop app serves from its remote-access
// listener. It is built on its own (not through electron-vite) into `out/remote-web`, which
// electron-builder packages along with the rest of `out/`.

const root = resolve('src/remote-web');
/** The desktop app's remote-access listener; `dev:remote-web` proxies the API and Wire to it. */
const hostUrl = process.env.REMOTE_WEB_HOST_URL ?? 'http://127.0.0.1:7462';

/** The placeholder in sw.js: a marker comment followed by the empty list it stands in for. */
const PRECACHE_PLACEHOLDER = /\/\*__PRECACHE_MANIFEST__\*\/\s*\[\]/;
/** Files that are always part of the shell even though Rollup does not emit them. */
const STATIC_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/theme-boot.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];

/**
 * Emits `sw.js` with the list of built shell files baked in, so the worker can cache the whole
 * shell at install and its bytes change whenever the build does (which is what makes browsers
 * pick up a new version).
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'remote-web-service-worker',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const built = Object.keys(bundle)
        // Only the Latin font subsets are needed up front; the rest are cached when first used.
        .filter((file) => !file.endsWith('.woff2') || /-latin-[^/]*\.woff2$/.test(file))
        .filter((file) => !file.endsWith('.map') && file !== 'index.html')
        .map((file) => `/${file}`);
      const files = [...STATIC_SHELL, ...built].sort();
      const template = await readFile(resolve(root, 'sw.js'), 'utf8');
      if (!PRECACHE_PLACEHOLDER.test(template)) {
        this.error('src/remote-web/sw.js is missing its /*__PRECACHE_MANIFEST__*/ [] placeholder');
      }
      const source = template.replace(PRECACHE_PLACEHOLDER, JSON.stringify(files));
      // A worker that fails to parse is silently never installed; fail the build instead.
      this.parse(source);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  publicDir: resolve(root, 'public'),
  plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
  resolve: {
    // Workspace packages publish their sources under the `development` condition. Building from
    // them (as the dev server already does) keeps this bundle independent of package `dist`
    // freshness; nothing else this app imports defines that condition.
    conditions: ['module', 'browser', 'development'],
  },
  build: {
    outDir: resolve('out/remote-web'),
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
    sourcemap: false,
    // One chunk on purpose: the service worker caches the whole shell, and React, xterm and
    // the Wire runtime are all needed on the first screen that matters.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 7463,
    strictPort: true,
    proxy: {
      '/api': { target: hostUrl, changeOrigin: false },
      '/wire': { target: hostUrl, ws: true, changeOrigin: false },
    },
  },
});
