/**
 * Registers the shell-caching service worker in production builds. (The dev server serves
 * modules that must never be cached, and has no built shell to cache.)
 *
 * A new build installs as a new worker and takes control in the background. The page running
 * the old build keeps working; it reloads itself onto the new one the next time it is put in
 * the background, which is when nobody is looking at it.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  let updated = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first worker claiming an uncontrolled page is an install, not an update.
    if (hadController) updated = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (updated && document.visibilityState === 'hidden') window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void registration.update().catch(() => {});
        });
      })
      .catch(() => {
        // Without a worker the app still works; it just loads from the network.
      });
  });
}

/**
 * Calls back with the in-app path of a notification the person tapped while the app was open.
 * (When it was closed, the worker opens the app at that path instead.)
 */
export function onNotificationNavigate(handler: (path: string) => void): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return;
    const { type, path } = data as { type?: unknown; path?: unknown };
    if (type === 'maestro:navigate' && typeof path === 'string') handler(path);
  });
}
