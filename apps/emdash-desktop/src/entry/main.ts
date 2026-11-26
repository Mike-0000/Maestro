import { app, dialog } from 'electron';
import { resolveLaunchMode } from '@main/client/launch-mode';
import { configureChromiumCommandLine } from '@main/host/chromium-command-line';

// Packaged Electron does not set NODE_ENV, so environment-keyed defaults (such
// as the wire validation policy) would otherwise resolve to their development
// behavior. Set it before any other module loads so spawned workers inherit it.
if (app.isPackaged && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// Electron consumes Chromium switches during initialization. Keep this call
// synchronous at module scope, before bootstrap's dynamic import crosses an
// event-loop boundary and `ready` may be emitted.
configureChromiumCommandLine({ commandLine: app.commandLine });

async function start(): Promise<void> {
  // `--maestro-client` (or MAESTRO_CLIENT in development) starts the thin client of a remote
  // Maestro host instead. Without it nothing below changes: the client bootstrap is never imported.
  if (
    resolveLaunchMode(process.argv, process.env, { isPackaged: app.isPackaged }).mode === 'client'
  ) {
    await startClient();
    return;
  }
  try {
    const { main } = await import('@main/bootstrap');
    await main();
  } catch (error) {
    try {
      const { enterSafeMode } = await import('@main/bootstrap/core/recovery');
      await enterSafeMode(error);
    } catch (recoveryError) {
      await app.whenReady();
      dialog.showErrorBox(
        'Something went wrong',
        `Maestro could not start recovery mode.\n\n${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        }`
      );
    }
  }
}

/** A client never enters local recovery: it has no local backend to recover. */
async function startClient(): Promise<void> {
  try {
    const { clientMain } = await import('@main/client/bootstrap');
    await clientMain();
  } catch (error) {
    await app.whenReady();
    dialog.showErrorBox(
      'Maestro client could not start',
      error instanceof Error ? error.message : String(error)
    );
    app.exit(1);
  }
}

void start();
