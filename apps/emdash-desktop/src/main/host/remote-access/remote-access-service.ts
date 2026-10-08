import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@emdash/core/workspace-server';
import { err, ok, type Result } from '@emdash/shared';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import {
  createInProcessWire,
  serve,
  type Controller,
  type InProcessWire,
  type WireTransport,
} from '@emdash/wire/rpc';
import { cell, peek } from '@emdash/wire/state';
import type {
  RemoteAccessError,
  RemoteAccessPairing,
  RemoteAccessStatus,
  RemoteAccessTailscale,
} from '@core/features/remote-access/api';
import type { RemoteAccessOperations } from '@core/features/remote-access/node/wire-controller';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import type { AppDb } from '@core/services/app-db/node/db';
import { tuiAgentStatusBridge } from '@main/core/agent-status/tui-agent-status-bridge';
import type { DesktopRuntimeClients } from '@main/gateway/desktop-workers';
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  isTriggerName,
  LOOPBACK_BIND_ADDRESS,
  RemoteDeviceStore,
  type RemoteDevice,
} from './device-store';
import { createBrowserDeviceController, createMaestroHostController } from './host-controller';
import {
  createRemoteAccessHttpServer,
  type RemoteAccessHttpServer,
  type RemoteAccessRoute,
} from './http-server';
import { PairingCodes } from './pairing';
import { createRemoteControl, type RemoteControl, type RemoteControlPorts } from './remote-control';
import { inspectTailscale, setTailscaleServe } from './tailscale';
import { createTriggerRoute } from './trigger-route';

type DesktopWire = InProcessWire<typeof desktopWireContract extends infer C ? C : never>;

export type RemoteAccessDependencies = {
  db: AppDb;
  clients: DesktopRuntimeClients;
  /** The controller the app's own window is served by. */
  desktopController: Controller;
  taskService: Pick<TaskService, 'provisionWorkspace'>;
  /** Directory for the settings file. */
  dataDirectory: string;
  /** Directory holding the built web app. */
  staticRoot: string;
  appVersion: string;
  hostName: string;
  logger: Logger;
  /** Extra HTTP surfaces served by the same listener. */
  routes?: readonly RemoteAccessRoute[];
};

type Attached = {
  deps: RemoteAccessDependencies;
  scope: Scope;
  store: RemoteDeviceStore;
  desktop: DesktopWire;
  remoteControl: RemoteControl;
  hostController: Controller;
  browserController: Controller;
};

const SETTINGS_FILE = 'remote-access.json';
const NOT_READY: RemoteAccessError = {
  type: 'unavailable',
  message: 'Remote access is still starting. Try again in a moment.',
};

/**
 * Lets other devices reach this Maestro: one HTTP listener that pairs devices, serves the web
 * app, and carries Wire over WebSocket to this app's own workers. It binds to loopback unless
 * told otherwise and does no TLS of its own; a tunnel (Tailscale, cloudflared) fronts it.
 */
export class RemoteAccessService {
  private readonly pairing = new PairingCodes();
  private readonly connections = new Map<string, number>();
  private readonly statusCell = cell<RemoteAccessStatus>({
    enabled: false,
    listening: false,
    port: DEFAULT_REMOTE_ACCESS_PORT,
    bindAddress: LOOPBACK_BIND_ADDRESS,
    error: null,
    hostName: '',
    webAppAvailable: false,
    devices: [],
    pairing: null,
    triggers: { tokenSet: false, routes: [] },
  });
  private attached: Attached | undefined;
  private http: RemoteAccessHttpServer | undefined;
  private listenError: string | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private pairingExpiry: ReturnType<typeof setTimeout> | undefined;

  readonly operations: RemoteAccessOperations = {
    status: this.statusCell,
    configure: (input) => this.configure(input),
    createPairingCode: () => this.createPairingCode(),
    cancelPairingCode: () => {
      this.pairing.cancel();
      this.publish();
    },
    revokeDevice: (deviceId) => this.revokeDevice(deviceId),
    rotateTriggerToken: async () => {
      if (!this.attached) return err(NOT_READY);
      const token = await this.attached.store.rotateTriggerToken();
      this.publish();
      return ok({ token });
    },
    setTrigger: async ({ name, automationId }) => {
      if (!this.attached) return err(NOT_READY);
      if (!isTriggerName(name)) {
        return err({
          type: 'invalid',
          message: 'Use a lowercase name of letters, digits and dashes.',
        });
      }
      if (!automationId.trim()) {
        return err({ type: 'invalid', message: 'Enter the automation id.' });
      }
      await this.attached.store.setTrigger(name, automationId.trim());
      this.publish();
      return ok<void>();
    },
    removeTrigger: async (name) => {
      await this.attached?.store.setTrigger(name, null);
      this.publish();
    },
    getTailscale: () => inspectTailscale(peek(this.statusCell).port),
    setTailscaleServe: (enabled) => this.setTailscaleServe(enabled),
  };

  /** Binds the service to the running app and starts the listener if it is enabled. */
  async attach(deps: RemoteAccessDependencies): Promise<void> {
    if (this.attached) return;
    const scope = createScope({ label: 'remote-access' });
    const store = new RemoteDeviceStore(join(deps.dataDirectory, SETTINGS_FILE));
    await store.load();
    const desktop = createInProcessWire(desktopWireContract, deps.desktopController);
    const remoteControl = createRemoteControl(
      remoteControlPorts(deps, store, desktop),
      scope.child('remote-control')
    );
    this.attached = {
      deps,
      scope,
      store,
      desktop,
      remoteControl,
      hostController: createMaestroHostController({
        clients: deps.clients,
        remote: remoteControl.impl,
        appVersion: deps.appVersion,
      }),
      browserController: createBrowserDeviceController(remoteControl.impl),
    };
    this.publish();
    await this.reconcileListener();
  }

  async dispose(): Promise<void> {
    const attached = this.attached;
    this.attached = undefined;
    clearTimeout(this.pairingExpiry);
    await this.enqueue(() => this.stopListener());
    if (!attached) return;
    attached.remoteControl.dispose();
    await attached.desktop.dispose();
    await attached.scope.dispose();
  }

  private async configure(input: {
    enabled?: boolean;
    port?: number;
    bindAddress?: string;
  }): Promise<Result<void, RemoteAccessError>> {
    const attached = this.attached;
    if (!attached) return err(NOT_READY);
    const before = attached.store.current();
    const next = await attached.store.update(input);
    const rebind = next.port !== before.port || next.bindAddress !== before.bindAddress;
    if (rebind) await this.enqueue(() => this.stopListener());
    await this.reconcileListener();
    if (next.enabled && this.listenError) {
      return err({ type: 'failed', message: this.listenError });
    }
    return ok<void>();
  }

  private createPairingCode(): RemoteAccessPairing {
    const issued = this.pairing.issue();
    clearTimeout(this.pairingExpiry);
    this.pairingExpiry = setTimeout(() => this.publish(), issued.expiresAt - Date.now() + 50);
    this.pairingExpiry.unref?.();
    this.publish();
    return issued;
  }

  private async revokeDevice(deviceId: string): Promise<void> {
    const attached = this.attached;
    if (!attached) return;
    await attached.store.removeDevice(deviceId);
    this.http?.closeDeviceSessions(deviceId);
    this.publish();
  }

  private async setTailscaleServe(
    enabled: boolean
  ): Promise<Result<RemoteAccessTailscale, RemoteAccessError>> {
    const status = peek(this.statusCell);
    if (enabled && !status.listening) {
      return err({ type: 'invalid', message: 'Turn remote access on first.' });
    }
    return setTailscaleServe(status.port, enabled);
  }

  /** Brings the listener in line with the stored setting; start/stop never overlap. */
  private reconcileListener(): Promise<void> {
    return this.enqueue(async () => {
      const attached = this.attached;
      if (!attached) return;
      const settings = attached.store.current();
      if (!settings.enabled) {
        await this.stopListener();
        this.listenError = null;
      } else if (!this.http) {
        await this.startListener(attached);
      }
      this.publish();
    });
  }

  private async startListener(attached: Attached): Promise<void> {
    const { deps, store } = attached;
    const settings = store.current();
    const http = createRemoteAccessHttpServer({
      store,
      pairing: this.pairing,
      staticRoot: deps.staticRoot,
      hostInfo: () => ({
        hostId: settings.hostId,
        hostName: deps.hostName,
        protocolVersion: PROTOCOL_VERSION,
      }),
      openSession: (device, transport) => this.openSession(attached, device, transport),
      onDevicesChanged: () => this.publish(),
      routes: [
        createTriggerRoute({
          automations: deps.clients.automations,
          triggers: () => store.current().triggers,
          log: (entry) => deps.logger.info('Trigger request', entry),
        }),
        ...(deps.routes ?? []),
      ],
      logger: deps.logger,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        http.server.once('error', reject);
        http.server.listen(settings.port, settings.bindAddress, () => {
          http.server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      await http.close().catch(() => {});
      this.listenError = describeListenError(error, settings.port);
      deps.logger.warn('Remote access listener failed to start', { error: this.listenError });
      return;
    }
    this.http = http;
    this.listenError = null;
    deps.logger.info('Remote access listening', {
      port: settings.port,
      bindAddress: settings.bindAddress,
    });
  }

  private async stopListener(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    this.connections.clear();
    await http?.close();
  }

  private openSession(attached: Attached, device: RemoteDevice, transport: WireTransport): void {
    const controller =
      device.kind === 'desktop' ? attached.hostController : attached.browserController;
    const stopServing = serve(transport, controller);
    this.connections.set(device.id, (this.connections.get(device.id) ?? 0) + 1);
    this.publish();
    transport.onDisconnect(() => {
      stopServing();
      const remaining = (this.connections.get(device.id) ?? 1) - 1;
      if (remaining > 0) this.connections.set(device.id, remaining);
      else this.connections.delete(device.id);
      this.publish();
    });
  }

  private publish(): void {
    const attached = this.attached;
    if (!attached) return;
    const settings = attached.store.current();
    this.statusCell.set({
      enabled: settings.enabled,
      listening: this.http !== undefined,
      port: settings.port,
      bindAddress: settings.bindAddress,
      error: settings.enabled ? this.listenError : null,
      hostName: attached.deps.hostName,
      webAppAvailable: existsSync(join(attached.deps.staticRoot, 'index.html')),
      devices: attached.store.devices().map((device) => ({
        ...device,
        connections: this.connections.get(device.id) ?? 0,
      })),
      pairing: this.pairing.current() ?? null,
      triggers: {
        tokenSet: settings.triggers.tokenDigest !== null,
        routes: Object.entries(settings.triggers.routes)
          .map(([name, route]) => ({ name, automationId: route.automationId }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      },
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(work);
    this.lifecycle = run.catch(() => {});
    return run;
  }
}

function remoteControlPorts(
  deps: RemoteAccessDependencies,
  store: RemoteDeviceStore,
  desktop: DesktopWire
): RemoteControlPorts {
  const { client } = desktop;
  let providers: Promise<Array<{ id: string; name: string }>> | undefined;
  return {
    db: deps.db,
    hostInfo: () => ({
      id: store.current().hostId,
      name: deps.hostName,
      appVersion: deps.appVersion,
    }),
    listProviders: () => {
      providers ??= client.agents
        .listMetadata()
        .then((metadata) => metadata.map(({ id, name }) => ({ id, name })))
        .catch((error: unknown) => {
          providers = undefined;
          throw error;
        });
      return providers;
    },
    createTask: (params) => client.tasks.createTask(params),
    provisionTask: async (taskId) => {
      const result = await deps.taskService.provisionWorkspace(taskId);
      return result.success ? { success: true } : { success: false, error: describe(result.error) };
    },
    hydrateConversation: (input) => attempt(() => client.conversations.hydrateConversation(input)),
    linkConversationToTask: (input) => client.conversations.linkConversationToTask(input),
    terminal: {
      output: (conversationId) =>
        client.conversations.tui.output.handle({ conversationId }).asLiveSource(),
      sendInput: (input) => attempt(() => client.conversations.tui.sendInput(input)),
      resize: (input) => attempt(() => client.conversations.tui.resize(input)),
    },
    sessions: {
      describe: (conversationId) => tuiAgentStatusBridge.describe(conversationId),
      onChanged: (listener) => tuiAgentStatusBridge.onChanged(listener),
    },
  };
}

type Outcome = { success: true } | { success: false; error: { type?: string; message?: string } };

/** Normalises a desktop call that fails either by result or by throwing. */
async function attempt(
  call: () => Promise<{ success: true } | { success: false; error: unknown }>
): Promise<Outcome> {
  try {
    const result = await call();
    return result.success ? { success: true } : { success: false, error: describe(result.error) };
  } catch (error) {
    return { success: false, error: describe(error) };
  }
}

function describe(error: unknown): { type?: string; message?: string } {
  if (error instanceof Error) return { message: error.message };
  if (typeof error === 'object' && error !== null) {
    const { type, message } = error as { type?: unknown; message?: unknown };
    return {
      ...(typeof type === 'string' ? { type } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  }
  return { message: String(error) };
}

function describeListenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') return `Port ${port} is already in use on this computer.`;
  if (code === 'EADDRNOTAVAIL') return 'That address does not belong to this computer.';
  if (code === 'EACCES') return `This computer does not allow listening on port ${port}.`;
  return error instanceof Error ? error.message : String(error);
}

export const remoteAccessService = new RemoteAccessService();
