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
