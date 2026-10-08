import { createServer } from 'node:http';
import {
  createTriggerRequestListener,
  loadTriggerGatewayConfig,
} from '@emdash/core/runtimes/automations/node';
import { DEFAULT_WORKSPACE_SERVER_SOCKET_PATH } from '../daemon/paths';
import { createTriggerDaemon } from './daemon-client';

/**
 * Runs the HTTP trigger gateway: a separate process from the daemon so its bearer
 * token never enters the daemon's environment, and therefore never reaches an agent.
 * It keeps no state; the automations database is the only record of a request.
 */
export async function runTriggerGateway(options: {
  socketPath: string | undefined;
  appVersion: string;
}): Promise<{ dispose(): Promise<void> }> {
  const config = await loadTriggerGatewayConfig();
  if (!config.success) throw new Error(config.error);

  const daemon = createTriggerDaemon({
    socketPath: options.socketPath ?? DEFAULT_WORKSPACE_SERVER_SOCKET_PATH,
    appVersion: options.appVersion,
  });
  const server = createServer(
    createTriggerRequestListener({
      config: config.data,
      daemon,
      log: (entry) => {
        process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
      },
    })
  );
  // A caller that stalls mid-request must not hold a connection open indefinitely.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const { host, port } = config.data.listen;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  process.stderr.write(
    `trigger gateway listening on http://${host}:${port} ` +
      `(${Object.keys(config.data.triggers).length} trigger(s))\n`
  );

  return {
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
