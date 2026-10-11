import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { err, ok, secret, type Result, type Secret } from '@emdash/shared';
import { eq } from 'drizzle-orm';
import {
  maestroHostAddress,
  normalizeMaestroHostUrl,
} from '@core/primitives/maestro-host/api/endpoint';
import {
  sshConfigFromRow,
  type SshConfig,
  type SshConnectionMetadata,
} from '@core/primitives/ssh/api';
import type { AppDb, DrizzleTx } from '@core/services/app-db/node/db';
import {
  sshConnections,
  type SshConnectionInsert,
  type SshConnectionRow,
} from '@core/services/app-db/node/schema';
import {
  maestroHostCredentialChanges,
  type MaestroHostCredentialService,
} from '@core/services/hosts/node/maestro/maestro-host-credentials';
import type {
  AddMaestroHostInput,
  InspectMaestroHostInput,
  MaestroHostError,
  MaestroHostErrorType,
  MaestroHostInfo,
  RepairMaestroHostInput,
  UpdateMaestroHostInput,
} from '../api/maestro-host';
import type { MachineMutationEvent } from '../api/node/machines-service';
import type { MaestroHostCfAccess, MaestroHostClient } from './maestro-host-client';

export interface MaestroHostsServiceDeps {
  db: AppDb;
  client: MaestroHostClient;
  credentials: Pick<MaestroHostCredentialService, 'getCfAccessClientSecret'>;
  /** Encrypts before the synchronous transaction that commits the row and its secrets together. */
  prepareSecrets(changes: ReadonlyMap<string, Secret<string> | null>): (tx: DrizzleTx) => void;
  /** Retires the machine's Host identity so the next connection uses what was just saved. */
  notifyMutated(event: MachineMutationEvent): void;
  /** How this device introduces itself to the host; defaults to the computer's name. */
  deviceName?: () => string;
  createId?: () => string;
  now?: () => number;
}

type MaestroHostResult<T> = Result<T, MaestroHostError>;

/**
 * Adds and maintains Maestro hosts: machines reached over the Maestro app's own WebSocket
 * listener. A host is trusted through a one-time pairing code that the host trades for a device
 * token; the token and any Cloudflare Access client secret go to the encrypted secret store,
 * never to the machine's metadata.
 */
export class MaestroHostsService {
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly deviceName: () => string;

  constructor(private readonly deps: MaestroHostsServiceDeps) {
    this.createId = deps.createId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.deviceName = deps.deviceName ?? (() => hostname() || 'Maestro desktop');
  }

  /** Asks the address who it is, without pairing or saving anything. */
  async inspect(input: InspectMaestroHostInput): Promise<MaestroHostResult<MaestroHostInfo>> {
    const url = normalizeMaestroHostUrl(input.url);
    if (!url.success) return err(url.error);
    const existing = input.machineId ? this.loadMaestroRow(input.machineId) : undefined;
    const cfAccess = await this.resolveCfAccess(input, existing);
    if (!cfAccess.success) return cfAccess;
    const info = await this.deps.client.info(url.data, cfAccess.data.cfAccess);
    if (!info.success) return info;
    return ok({ url: url.data, ...info.data });
  }

  /** Pairs with a host and saves it as a new machine. */
  async add(input: AddMaestroHostInput): Promise<MaestroHostResult<SshConfig>> {
    const url = normalizeMaestroHostUrl(input.url);
    if (!url.success) return err(url.error);
    const code = input.code.trim();
    if (!code) return failure('invalid-code', 'Enter the pairing code shown by the host.');
    const cfAccess = await this.resolveCfAccess(input, undefined);
    if (!cfAccess.success) return cfAccess;

    const info = await this.deps.client.info(url.data, cfAccess.data.cfAccess);
    if (!info.success) return info;
    const rows = await this.deps.db.select().from(sshConnections);
    const duplicate = rows.find(
      (row) =>
        row.metadata?.transport === 'maestro' && row.metadata.maestro?.hostId === info.data.hostId
    );
    if (duplicate) {
      return failure(
        'already-added',
        `That host is already added as "${duplicate.name}". Open it to pair again or change its address.`
      );
    }

    const pairing = await this.deps.client.pair(
      url.data,
      { code, deviceName: this.deviceName() },
      cfAccess.data.cfAccess
    );
    if (!pairing.success) return pairing;

    const id = this.createId();
    const address = maestroHostAddress(url.data);
    const row = {
      id,
      name: uniqueName(pairing.data.hostName || info.data.hostName || address.host, rows),
      host: address.host,
      port: address.port,
      // A Maestro host has no SSH account; these columns only satisfy the shared machine row.
      username: '',
      authType: 'agent',
      privateKeyPath: null,
      useAgent: 0,
      metadata: {
        version: '7',
        transport: 'maestro',
        maestro: {
          url: url.data,
          hostId: pairing.data.hostId,
          ...(cfAccess.data.cfAccess ? { cfAccessClientId: cfAccess.data.cfAccess.clientId } : {}),
        },
      } satisfies SshConnectionMetadata,
    } satisfies SshConnectionInsert;
    const applySecrets = this.deps.prepareSecrets(
      maestroHostCredentialChanges(id, {
        deviceToken: pairing.data.token,
        cfAccessClientSecret: cfAccess.data.cfAccess?.clientSecret ?? null,
      })
    );
    this.deps.db.transaction((tx) => {
      tx.insert(sshConnections).values(row).run();
      applySecrets(tx);
    });
    this.deps.notifyMutated({ type: 'saved', connectionId: id });
    return ok(sshConfigFromRow(row));
  }

  /** Pairs an existing machine again, after its token was revoked on the host. */
  async repair(input: RepairMaestroHostInput): Promise<MaestroHostResult<SshConfig>> {
    const existing = this.loadMaestroRow(input.id);
    if (!existing) return notFound();
    const code = input.code.trim();
    if (!code) return failure('invalid-code', 'Enter the pairing code shown by the host.');
    const cfAccess = await this.resolveCfAccess({}, existing);
    if (!cfAccess.success) return cfAccess;

    const url = existing.maestro.url;
    const info = await this.deps.client.info(url, cfAccess.data.cfAccess);
    if (!info.success) return info;
    const mismatch = hostMismatch(existing, info.data.hostId);
    if (mismatch) return mismatch;

    const pairing = await this.deps.client.pair(
      url,
      { code, deviceName: this.deviceName() },
      cfAccess.data.cfAccess
    );
    if (!pairing.success) return pairing;

    const metadata: SshConnectionMetadata = {
      ...existing.row.metadata,
      version: '7',
      transport: 'maestro',
      maestro: { ...existing.maestro, hostId: pairing.data.hostId },
    };
    return this.persist(
      existing.row,
      { metadata },
      maestroHostCredentialChanges(input.id, { deviceToken: pairing.data.token })
    );
  }

  /** Changes a machine's address or Cloudflare Access credentials, keeping its pairing. */
  async update(input: UpdateMaestroHostInput): Promise<MaestroHostResult<SshConfig>> {
    const existing = this.loadMaestroRow(input.id);
    if (!existing) return notFound();
    const url = normalizeMaestroHostUrl(input.url);
    if (!url.success) return err(url.error);
    const cfAccess = await this.resolveCfAccess(input, existing);
    if (!cfAccess.success) return cfAccess;

    // The saved token only works on the host that issued it, so the new address must be that host.
    const info = await this.deps.client.info(url.data, cfAccess.data.cfAccess);
    if (!info.success) return info;
    const mismatch = hostMismatch(existing, info.data.hostId);
    if (mismatch) return mismatch;

    const address = maestroHostAddress(url.data);
    const metadata: SshConnectionMetadata = {
      ...existing.row.metadata,
      version: '7',
      transport: 'maestro',
      maestro: {
        url: url.data,
        hostId: existing.maestro.hostId ?? info.data.hostId,
        ...(cfAccess.data.cfAccess ? { cfAccessClientId: cfAccess.data.cfAccess.clientId } : {}),
      },
    };
    return this.persist(
      existing.row,
      { host: address.host, port: address.port, metadata },
      maestroHostCredentialChanges(input.id, {
        // Undefined keeps a reused saved secret; null removes the secret of a cleared client ID.
        cfAccessClientSecret: cfAccess.data.cfAccess
          ? cfAccess.data.replaced
            ? cfAccess.data.cfAccess.clientSecret
            : undefined
          : null,
      })
    );
  }

  private persist(
    row: SshConnectionRow,
    change: Partial<Pick<SshConnectionRow, 'host' | 'port'>> & { metadata: SshConnectionMetadata },
    secrets: ReadonlyMap<string, Secret<string> | null>
  ): MaestroHostResult<SshConfig> {
    const applySecrets = this.deps.prepareSecrets(secrets);
    const updatedAt = new Date(this.now()).toISOString();
    const saved = this.deps.db.transaction((tx) => {
      const updated = tx
        .update(sshConnections)
        .set({ ...change, updatedAt })
        .where(eq(sshConnections.id, row.id))
        .returning()
        .get();
      if (updated) applySecrets(tx);
      return updated;
    });
    if (!saved) return notFound();
    this.deps.notifyMutated({ type: 'saved', connectionId: row.id });
    return ok(sshConfigFromRow(saved));
  }

  private loadMaestroRow(
    id: string
  ): { row: SshConnectionRow; maestro: NonNullable<SshConnectionMetadata['maestro']> } | undefined {
    const row = this.deps.db.select().from(sshConnections).where(eq(sshConnections.id, id)).get();
    if (row?.metadata?.transport !== 'maestro' || !row.metadata.maestro) return undefined;
    return { row, maestro: row.metadata.maestro };
  }

  /**
   * The Cloudflare Access service token to use. A typed secret always wins; a blank secret reuses
   * the saved one only for the machine's unchanged client ID, never for a different ID.
   */
  private async resolveCfAccess(
    input: { cfAccessClientId?: string; cfAccessClientSecret?: string },
    existing: ReturnType<MaestroHostsService['loadMaestroRow']>
  ): Promise<MaestroHostResult<{ cfAccess?: MaestroHostCfAccess; replaced: boolean }>> {
    const savedClientId = existing?.maestro.cfAccessClientId;
    // Callers that do not edit the credentials (re-pair) omit both fields and keep what is saved.
    const editing =
      input.cfAccessClientId !== undefined || input.cfAccessClientSecret !== undefined;
    const clientId = editing ? input.cfAccessClientId?.trim() || undefined : savedClientId;
    const typedSecret = input.cfAccessClientSecret?.trim() || undefined;
    if (!clientId) {
      if (typedSecret) {
        return failure(
          'cloudflare-access',
          'Enter the Cloudflare Access client ID that goes with the client secret.'
        );
      }
      return ok({ replaced: false });
    }
    if (typedSecret) {
      return ok({
        cfAccess: { clientId, clientSecret: secret(typedSecret, 'cf-access-client-secret') },
        replaced: true,
      });
    }
    const saved =
      existing && clientId === savedClientId
        ? await this.deps.credentials.getCfAccessClientSecret(existing.row.id)
        : null;
    if (!saved) {
      return failure('cloudflare-access', 'Enter the Cloudflare Access client secret.');
    }
    return ok({ cfAccess: { clientId, clientSecret: saved }, replaced: false });
  }
}

function hostMismatch(
  existing: { maestro: { hostId?: string } },
  hostId: string
): MaestroHostResult<never> | undefined {
  if (!existing.maestro.hostId || existing.maestro.hostId === hostId) return undefined;
  return failure(
    'host-mismatch',
    'That address answers as a different Maestro host than the one this machine was paired with. Add it as a new machine instead.'
  );
}

function uniqueName(baseName: string, rows: ReadonlyArray<{ name: string }>): string {
  const names = new Set(rows.map((row) => row.name));
  let name = baseName;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;
  return name;
}

function notFound(): MaestroHostResult<never> {
  return failure('not-found', 'This machine is no longer a Maestro host on this device.');
}

function failure(type: MaestroHostErrorType, message: string): MaestroHostResult<never> {
  return err({ type, message });
}
