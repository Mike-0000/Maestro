import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  createConversationRegistry,
  conversationRegistryTable as conversationRows,
} from '@core/features/conversations/api/node/registry';
import {
  createWorkspaceRegistry,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import { HookCore, type Hookable } from '@core/primitives/hooks/api/hookable';
import { maestroHostUnsupportedMessage } from '@core/primitives/maestro-host/api/unsupported';
import {
  mergeSshConnectionMetadata,
  sshConfigFromRow,
  type SshConfig,
  type SshConnectionMetadata,
  type SshConnectionUsage,
} from '@core/primitives/ssh/api';
import type { AppDb, DrizzleTx } from '@core/services/app-db/node/db';
import {
  projects,
  sshConnections as sshConnectionsTable,
  type SshConnectionInsert,
} from '@core/services/app-db/node/schema';
import { resolveSshConfig } from '@core/services/ssh/node/config/resolve-ssh-config';
import {
  assertPasswordDestination,
  effectiveSshConfig,
  readSshPrivateKey,
} from '@core/services/ssh/node/credentials/credential-identity';
import {
  resolveCredentialDraft,
  type ResolvedCredentialDraft,
} from '@core/services/ssh/node/credentials/resolve-credential-draft';
import type { SshCredentialService } from '@core/services/ssh/node/credentials/ssh-credential-service';
import { listWslDistros } from '@core/services/ssh/node/local/wsl-distros';
import { setUpRepositoryInWsl } from '@core/services/ssh/node/local/wsl-setup';
import type { SaveMachineInput } from '..';
import { captureMachineSave, persistMachine } from '../../node/machine-persistence';

type MachinesCredentials = Pick<
  SshCredentialService,
  'getPassword' | 'getPassphrase' | 'deleteAllCredentials'
>;

type MachinesSshRuntime = {
  dropConnection(connectionId: string): Promise<void>;
  removeRuntimeState(connectionId: string): void;
};

type MachinesLog = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export interface MachinesServiceDeps {
  db: AppDb;
  credentials: MachinesCredentials;
  /** Device token and Cloudflare secret of Maestro hosts; removed with the machine. */
  maestroCredentials?: { deleteAllCredentials(connectionId: string): Promise<void> };
  prepareCredentials: (id: string, credentials: ResolvedCredentialDraft) => (tx: DrizzleTx) => void;
  resolveSshConfig?: typeof resolveSshConfig;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  ssh: MachinesSshRuntime;
  log: MachinesLog;
  createId?: () => string;
  now?: () => number;
}

export type MachineMutationEvent = {
  type: 'saved' | 'deleted';
  connectionId: string;
};

export type SyncLocalSettingsChangedEvent = {
  connectionId: string;
  enabled: boolean;
};

export type MachinesServiceHooks = {
  'machine:mutated': (event: MachineMutationEvent) => void | Promise<void>;
  /**
   * The per-host "Sync local settings" toggle changed. Separate from
   * machine:mutated on purpose: flipping the toggle must not invalidate the
   * host's pinned connection.
   */
  'machine:sync-local-settings-changed': (
    event: SyncLocalSettingsChangedEvent
  ) => void | Promise<void>;
};

export class MachinesService implements Hookable<MachinesServiceHooks> {
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly hooks: HookCore<MachinesServiceHooks>;

  constructor(private readonly deps: MachinesServiceDeps) {
    this.createId = deps.createId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.hooks = new HookCore<MachinesServiceHooks>((name, error) => {
      deps.log.warn(`MachinesService: ${String(name)} hook failed`, { error });
    });
  }

  on<K extends keyof MachinesServiceHooks>(name: K, handler: MachinesServiceHooks[K]): () => void {
    return this.hooks.on(name, handler);
  }

  /** For sibling services that persist a machine themselves (Maestro hosts). */
  notifyMutated(event: MachineMutationEvent): void {
    this.hooks.callHookBackground('machine:mutated', event);
  }

  async getMachines(): Promise<SshConfig[]> {
    const rows = await this.deps.db.select().from(sshConnectionsTable);
    return rows.map(sshConfigFromRow);
  }

  async getMachineUsage(): Promise<SshConnectionUsage> {
    const rows = await this.deps.db
      .select({
        id: projects.id,
        name: projects.name,
        sshConnectionId: workspaces.sshConnectionId,
      })
      .from(projects)
      .leftJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
      .where(isNull(projects.deletedAt));

    const usage: SshConnectionUsage = {};
    for (const row of rows) {
      if (!row.sshConnectionId) continue;
      usage[row.sshConnectionId] ??= [];
      usage[row.sshConnectionId].push({ id: row.id, name: row.name });
    }
    return usage;
  }

  async saveMachine(config: SaveMachineInput): Promise<SshConfig> {
    const connectionId = config.id ?? this.createId();
    const existingConnectionWithName = await this.deps.db
      .select({ id: sshConnectionsTable.id })
      .from(sshConnectionsTable)
      .where(
        config.id
          ? and(eq(sshConnectionsTable.name, config.name), ne(sshConnectionsTable.id, connectionId))
          : eq(sshConnectionsTable.name, config.name)
      )
      .limit(1);

    if (existingConnectionWithName.length > 0) {
      throw new Error(
        `An SSH connection named “${config.name}” already exists. Choose a different name.`
      );
    }

    const { password: _password, passphrase: _passphrase, ...dbConfig } = config;

    const before = captureMachineSave(this.deps.db, connectionId);
    if (before.connection?.metadata?.transport === 'local') {
      throw new Error('This computer connects without SSH, so it has no SSH settings to edit.');
    }
    if (before.connection?.metadata?.transport === 'maestro') {
      throw new Error(maestroHostUnsupportedMessage('ssh-settings'));
    }
    if (before.connection?.metadata?.transport === 'wsl') {
      throw new Error('A WSL distro connects without SSH, so it has no SSH settings to edit.');
    }
    const existingMetadata: SshConnectionMetadata = before.connection?.metadata ?? {};

    const metadataUpdate: SshConnectionMetadata = {};
    if (Object.prototype.hasOwnProperty.call(config, 'sshConfigAlias')) {
      metadataUpdate.sshConfigAlias = config.sshConfigAlias;
    }
    if (Object.prototype.hasOwnProperty.call(config, 'forwardAgent')) {
      metadataUpdate.forwardAgent = config.forwardAgent;
    }
    if (Object.prototype.hasOwnProperty.call(config, 'proxyJump')) {
      metadataUpdate.proxyJump = config.proxyJump;
    }
    const metadata = mergeSshConnectionMetadata(existingMetadata, metadataUpdate);

    const previous = before.connection ? sshConfigFromRow(before.connection) : undefined;
    const draft = {
      ...config,
      sshConfigAlias: metadata.sshConfigAlias,
      proxyJump: metadata.proxyJump,
    };
    const resolved = draft.sshConfigAlias
      ? await (this.deps.resolveSshConfig ?? resolveSshConfig)(draft.sshConfigAlias)
      : undefined;
    const effective = effectiveSshConfig(draft, resolved);
    assertPasswordDestination(draft, effective);
    const key =
      draft.authType === 'key'
        ? await readSshPrivateKey(draft, resolved, this.deps.readFile ?? readFile)
        : undefined;
    const credentials = await resolveCredentialDraft(
      effective,
      previous,
      this.deps.credentials,
      key?.fingerprint
    );
    const applyCredentials = this.deps.prepareCredentials(connectionId, credentials);

    const insertData: SshConnectionInsert = {
      id: connectionId,
      name: dbConfig.name,
      host: effective.host,
      port: effective.port,
      metadata,
      username: effective.username,
      authType: dbConfig.authType,
      privateKeyPath: dbConfig.privateKeyPath ?? null,
      useAgent: dbConfig.useAgent ? 1 : 0,
    };

    persistMachine(
      this.deps.db,
      before,
      insertData,
      applyCredentials,
      new Date(this.now()).toISOString()
    );

    if (previous) {
      await this.deps.ssh.dropConnection(connectionId).catch((error: unknown) => {
        this.deps.log.warn('MachinesService.saveMachine: error disconnecting previous config', {
          connectionId,
          error: String(error),
        });
      });
    }
    this.hooks.callHookBackground('machine:mutated', { type: 'saved', connectionId });

    return {
      ...dbConfig,
      host: effective.host,
      port: effective.port,
      username: effective.username,
      id: connectionId,
      sshConfigAlias: metadata.sshConfigAlias,
      forwardAgent: metadata.forwardAgent,
      proxyJump: metadata.proxyJump,
      syncLocalSettings: metadata.syncLocalSettings,
    };
  }

  /**
   * Adds this computer as a Host that runs its workspace server directly, without SSH, or returns
   * the one already added. SSH clients of this computer reach the same workspace server, so their
   * conversations show up here and can be continued from here, and the other way around.
   */
  async addThisComputer(): Promise<SshConfig> {
    const rows = await this.deps.db.select().from(sshConnectionsTable);
    const existing = rows.find((row) => row.metadata?.transport === 'local');
    if (existing) return sshConfigFromRow(existing);

    const names = new Set(rows.map((row) => row.name));
    const baseName = `${hostname() || 'This computer'} (this computer)`;
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;

    const row = {
      id: this.createId(),
      name,
      host: 'localhost',
      port: 0,
      username: userInfo().username,
      authType: 'agent',
      privateKeyPath: null,
      useAgent: 0,
      metadata: { version: '7', transport: 'local' } satisfies SshConnectionMetadata,
    } satisfies SshConnectionInsert;
    await this.deps.db.insert(sshConnectionsTable).values(row);
    this.hooks.callHookBackground('machine:mutated', { type: 'saved', connectionId: row.id });
    return sshConfigFromRow(row);
  }

  /**
   * Adds a WSL2 distro on this computer as a Host, or returns the one already added. With no
   * name it takes the first usable distro that is not a machine yet. The Host's workspace
   * server, repositories and agents live on the distro's own filesystem.
   */
  async addWslDistro(requested?: string): Promise<SshConfig> {
    if (process.platform !== 'win32') throw new Error('WSL distros exist only on Windows.');
    const distros = await listWslDistros();
    if (distros.length === 0) {
      throw new Error(
        'No WSL2 Linux distro was found. Install one first, for example with "wsl --install -d Ubuntu".'
      );
    }
    const rows = await this.deps.db.select().from(sshConnectionsTable);
    const added = new Map(
      rows
        .filter((row) => row.metadata?.transport === 'wsl' && row.metadata.wsl)
        .map((row) => [row.metadata?.wsl?.distro.toLowerCase() ?? '', row] as const)
    );
    const wanted = requested
      ? distros.find((distro) => distro.name.toLowerCase() === requested.toLowerCase())
      : (distros.find((distro) => !added.has(distro.name.toLowerCase())) ?? distros[0]);
    if (!wanted) throw new Error(`No WSL2 distro is called "${requested}".`);
    const existing = added.get(wanted.name.toLowerCase());
    if (existing) return sshConfigFromRow(existing);

    const names = new Set(rows.map((row) => row.name));
    const baseName = `${wanted.name} (WSL)`;
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;

    const row = {
      id: this.createId(),
      name,
      host: 'localhost',
      port: 0,
      username: userInfo().username,
      authType: 'agent',
      privateKeyPath: null,
      useAgent: 0,
      metadata: {
        version: '7',
        transport: 'wsl',
        wsl: { distro: wanted.name },
      } satisfies SshConnectionMetadata,
    } satisfies SshConnectionInsert;
    await this.deps.db.insert(sshConnectionsTable).values(row);
    this.hooks.callHookBackground('machine:mutated', { type: 'saved', connectionId: row.id });
    return sshConfigFromRow(row);
  }

  /**
   * Copies a repository on a Windows drive into a WSL2 distro and returns where a project for
   * it can be created: the distro's machine (added when it was not one yet) and the copy's
   * path. A distro is installed first when the computer has none. Nothing is registered here;
   * the caller creates the project the usual way.
   */
  async copyRepositoryToWsl(input: {
    windowsPath: string;
    name: string;
  }): Promise<{ machine: SshConfig; path: string; reused: boolean; notes: string[] }> {
    if (process.platform !== 'win32') throw new Error('WSL exists only on Windows.');
    const setup = await setUpRepositoryInWsl(input);
    const machine = await this.addWslDistro(setup.distro);
    return { machine, path: setup.path, reused: setup.reused, notes: [...setup.notes] };
  }

  async setSyncLocalSettings(id: string, enabled: boolean): Promise<SshConfig> {
    const [row] = await this.deps.db
      .select()
      .from(sshConnectionsTable)
      .where(eq(sshConnectionsTable.id, id));
    if (!row) throw new Error(`SSH connection ${id} not found`);

    const metadata: SshConnectionMetadata = {
      ...(row.metadata ?? {}),
      version: '7',
      syncLocalSettings: enabled,
    };
    await this.deps.db
      .update(sshConnectionsTable)
      .set({ metadata, updatedAt: new Date(this.now()).toISOString() })
      .where(eq(sshConnectionsTable.id, id));

    this.hooks.callHookBackground('machine:sync-local-settings-changed', {
      connectionId: id,
      enabled,
    });
    return sshConfigFromRow({ ...row, metadata });
  }

  async deleteMachine(id: string): Promise<void> {
    const referencingProjects = await this.deps.db
      .select({ name: projects.name })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
      .where(and(eq(workspaces.sshConnectionId, id), isNull(projects.deletedAt)));

    if (referencingProjects.length > 0) {
      const projectNames = referencingProjects.map((project) => project.name).join(', ');
      throw new Error(`SSH connection is used by ${projectNames}`);
    }

    // Forget-host cascade: purge the host's workspace mirror rows — pending deletion
    // tombstones included (ADR 0006: forget means forget). Nothing host-side is
    // touched; re-adding the host reconverges from its own registry.
    const registryIds = this.deps.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.sshConnectionId, id))
      .all()
      .map(({ id: workspaceId }) => workspaceId);
    if (registryIds.length > 0) {
      const workspaceRegistry = createWorkspaceRegistry(this.deps.db);
      this.deps.db.transaction((tx) => {
        workspaceRegistry.untrack(registryIds, new Date(this.now()).toISOString(), undefined, tx);
        workspaceRegistry.purge(registryIds, tx);
      });
    }

    // Conversation mirror rules (spec §7.3): task-linked cached records stay visible as
    // stale observations; unlinked mirror rows drop with the mirror. The host's own index
    // is untouched — re-adding the host reconverges everything, because the client never
    // held authority.
    const unlinkedMirrorIds = this.deps.db
      .select({ id: conversationRows.id })
      .from(conversationRows)
      .where(and(eq(conversationRows.sshConnectionId, id), isNull(conversationRows.taskId)))
      .all()
      .map(({ id: conversationId }) => conversationId);
    if (unlinkedMirrorIds.length > 0) {
      const conversationRegistry = createConversationRegistry(this.deps.db);
      this.deps.db.transaction((tx) => {
        conversationRegistry.untrack(unlinkedMirrorIds, new Date(this.now()).toISOString(), tx);
        conversationRegistry.purge(unlinkedMirrorIds, tx);
      });
    }

    await this.deps.ssh.dropConnection(id).catch((error: unknown) => {
      this.deps.log.warn('MachinesService.deleteMachine: error disconnecting', {
        connectionId: id,
        error: String(error),
      });
    });
    await this.deps.db.delete(sshConnectionsTable).where(eq(sshConnectionsTable.id, id));
    try {
      await this.deps.credentials.deleteAllCredentials(id);
      await this.deps.maestroCredentials?.deleteAllCredentials(id);
    } finally {
      this.deps.ssh.removeRuntimeState(id);
      this.hooks.callHookBackground('machine:mutated', {
        type: 'deleted',
        connectionId: id,
      });
    }
  }

  async renameMachine(id: string, name: string): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(sshConnectionsTable)
      .where(eq(sshConnectionsTable.id, id));
    if (!row) throw new Error(`SSH connection ${id} not found`);
    await this.deps.db
      .update(sshConnectionsTable)
      .set({ name, updatedAt: new Date(this.now()).toISOString() })
      .where(eq(sshConnectionsTable.id, id));
  }
}
