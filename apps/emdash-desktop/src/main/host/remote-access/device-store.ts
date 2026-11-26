import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * The kinds stored in `devices[]`: a Maestro app gets the host's workspace runtimes, a browser
 * only remote control. This enum must stay exactly as older builds know it: they reject (and
 * then reset) the whole file when `devices[]` holds a kind they do not know.
 */
export const remoteDeviceKindSchema = z.enum(['desktop', 'browser']);

/** The kinds an ordinary pairing code may create. Owners pair only through the owner route. */
export const pairableDeviceKindSchema = z.enum(['desktop', 'browser']);
export type PairableDeviceKind = z.infer<typeof pairableDeviceKindSchema>;

/**
 * Every kind of paired device. An owner (a client-mode Maestro) reaches the full desktop app; it
 * is kept in its own `ownerDevices[]`, which older builds drop as an unknown key instead of
 * failing on it.
 */
export type RemoteDeviceKind = PairableDeviceKind | 'owner';

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: remoteDeviceKindSchema,
  /** SHA-256 of the device token. The token itself is only ever held by the device. */
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
});

/** An owner device record: the same fields, with the kind implied by the array. */
const ownerDeviceSchema = deviceSchema.omit({ kind: true });

const TRIGGER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const triggersSchema = z.object({
  /** SHA-256 of the bearer token callers present; null until one is generated. */
  tokenDigest: z.string().nullable(),
  /** The allowlist: a caller names a trigger, never an automation. */
  routes: z.record(z.string().regex(TRIGGER_NAME_PATTERN), z.object({ automationId: z.string() })),
  maxQueued: z.number().int().positive(),
});

const DEFAULT_TRIGGERS: z.infer<typeof triggersSchema> = {
  tokenDigest: null,
  routes: {},
  maxQueued: 20,
};

/** Full-access (owner) clients. Off unless the person turns it on. */
const ownerAccessSchema = z.object({
  enabled: z.boolean().default(false),
  /** Accept owners only through `tailscale serve` or a direct loopback connection. */
  tailscaleOnly: z.boolean().default(true),
  /** Tailnet logins allowed as owners; empty allows every tailnet user. */
  allowedLogins: z.array(z.string()).default([]),
});

const DEFAULT_OWNER_ACCESS: z.infer<typeof ownerAccessSchema> = {
  enabled: false,
  tailscaleOnly: true,
  allowedLogins: [],
};

/** How this host installs its own updates: by a click, or by itself once it is idle. */
const hostUpdatesSchema = z.object({
  mode: z.enum(['manual', 'when-idle']).default('manual'),
});

const DEFAULT_HOST_UPDATES: z.infer<typeof hostUpdatesSchema> = { mode: 'manual' };

const stateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  bindAddress: z.string(),
  hostId: z.string(),
  devices: z.array(deviceSchema),
  /** Owner devices, apart from `devices[]` so an older build still reads the file. */
  ownerDevices: z.array(ownerDeviceSchema).default([]),
  triggers: triggersSchema.default(DEFAULT_TRIGGERS),
  ownerAccess: ownerAccessSchema.default(DEFAULT_OWNER_ACCESS),
  hostUpdates: hostUpdatesSchema.default(DEFAULT_HOST_UPDATES),
});

export type RemoteDeviceRecord = z.infer<typeof deviceSchema>;
type OwnerDeviceRecord = z.infer<typeof ownerDeviceSchema>;
export type RemoteAccessState = z.infer<typeof stateSchema>;
/** A paired device of any kind, as the rest of the app sees it (never with its token hash). */
export type RemoteDevice = Omit<RemoteDeviceRecord, 'tokenHash' | 'kind'> & {
  kind: RemoteDeviceKind;
};
export type RemoteTriggers = z.infer<typeof triggersSchema>;
export type RemoteOwnerAccessSettings = z.infer<typeof ownerAccessSchema>;
export type RemoteHostUpdates = z.infer<typeof hostUpdatesSchema>;

export function isTriggerName(value: string): boolean {
  return TRIGGER_NAME_PATTERN.test(value);
}

export const DEFAULT_REMOTE_ACCESS_PORT = 7462;
export const LOOPBACK_BIND_ADDRESS = '127.0.0.1';

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * Durable remote-access settings and the paired-device list, kept as one JSON file in the
 * app's data directory. It holds no secrets: device tokens are stored only as hashes.
 */
export class RemoteDeviceStore {
  private state: RemoteAccessState | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async load(): Promise<RemoteAccessState> {
    if (this.state) return this.state;
    this.state = await this.read();
    return this.state;
  }

  current(): RemoteAccessState {
    if (!this.state) throw new Error('Remote access settings are not loaded');
    return this.state;
  }

  /** Every paired device: ordinary ones first, then owners. */
  devices(): RemoteDevice[] {
    const state = this.current();
    return [
      ...state.devices.map(({ tokenHash: _tokenHash, ...device }) => device),
      ...state.ownerDevices.map(({ tokenHash: _tokenHash, ...device }) => ({
        ...device,
        kind: 'owner' as const,
      })),
    ];
  }

  async update(
    patch: Partial<Pick<RemoteAccessState, 'enabled' | 'port' | 'bindAddress'>>
  ): Promise<RemoteAccessState> {
    this.state = stateSchema.parse({ ...this.current(), ...patch });
    await this.persist();
    return this.state;
  }

  /** Changes the owner-access settings; omitted fields keep their value. */
  async updateOwnerAccess(patch: Partial<RemoteOwnerAccessSettings>): Promise<RemoteAccessState> {
    const state = this.current();
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    );
    this.state = stateSchema.parse({ ...state, ownerAccess: { ...state.ownerAccess, ...defined } });
    await this.persist();
    return this.state;
  }

  /** Registers a device and returns the credential it presents from now on. */
  async addDevice(input: {
    name: string;
    kind: RemoteDeviceKind;
  }): Promise<{ device: RemoteDevice; credential: string }> {
    const token = randomBytes(32).toString('base64url');
    const record: OwnerDeviceRecord = {
      id: randomUUID(),
      name: input.name,
      tokenHash: hashToken(token),
      createdAt: this.now(),
      lastSeenAt: null,
    };
    const state = this.current();
    const kind = input.kind;
    this.state =
      kind === 'owner'
        ? { ...state, ownerDevices: [...state.ownerDevices, record] }
        : { ...state, devices: [...state.devices, { ...record, kind }] };
    await this.persist();
    const { tokenHash: _tokenHash, ...device } = record;
    return { device: { ...device, kind }, credential: `${record.id}.${token}` };
  }

  /** Forgets a device of any kind. */
  async removeDevice(deviceId: string): Promise<boolean> {
    const state = this.current();
    const devices = state.devices.filter((device) => device.id !== deviceId);
    const ownerDevices = state.ownerDevices.filter((device) => device.id !== deviceId);
    const removed =
      devices.length !== state.devices.length || ownerDevices.length !== state.ownerDevices.length;
    if (!removed) return false;
    this.state = { ...state, devices, ownerDevices };
    await this.persist();
    return true;
  }

  /** Replaces the trigger bearer token and returns it; only its digest is kept. */
  async rotateTriggerToken(): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const state = this.current();
    this.state = { ...state, triggers: { ...state.triggers, tokenDigest: hashToken(token) } };
    await this.persist();
    return token;
  }

  /** Maps a trigger name to an automation, or removes the mapping when `automationId` is null. */
  async setTrigger(name: string, automationId: string | null): Promise<void> {
    const state = this.current();
    const routes = { ...state.triggers.routes };
    if (automationId === null) delete routes[name];
    else routes[name] = { automationId };
    this.state = stateSchema.parse({ ...state, triggers: { ...state.triggers, routes } });
    await this.persist();
  }

  /** Resolves a presented `<deviceId>.<token>` credential to its device, or undefined. */
  authenticate(credential: string | undefined): RemoteDevice | undefined {
    if (!credential) return undefined;
    const separator = credential.indexOf('.');
    if (separator <= 0) return undefined;
    const id = credential.slice(0, separator);
    const state = this.current();
    const ordinary = state.devices.find((device) => device.id === id);
    const owner = ordinary ? undefined : state.ownerDevices.find((device) => device.id === id);
    const record = ordinary ?? owner;
    if (!record) return undefined;
    const presented = Buffer.from(hashToken(credential.slice(separator + 1)), 'hex');
    const expected = Buffer.from(record.tokenHash, 'hex');
    if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
      return undefined;
    }
    this.touch(record);
    const { tokenHash: _tokenHash, ...device } = record;
    return ordinary ? { ...device, kind: ordinary.kind } : { ...device, kind: 'owner' };
  }

  private touch(record: OwnerDeviceRecord): void {
    const now = this.now();
    if (record.lastSeenAt !== null && now - record.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS) return;
    const state = this.current();
    const seen = <T extends OwnerDeviceRecord>(device: T): T =>
      device.id === record.id ? { ...device, lastSeenAt: now } : device;
    this.state = {
      ...state,
      devices: state.devices.map(seen),
      ownerDevices: state.ownerDevices.map(seen),
    };
    void this.persist().catch(() => {});
  }

  private async read(): Promise<RemoteAccessState> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or unreadable settings fall through to a fresh, disabled state.
    }
    return {
      version: 1,
      enabled: false,
      port: DEFAULT_REMOTE_ACCESS_PORT,
      bindAddress: LOOPBACK_BIND_ADDRESS,
      hostId: randomUUID(),
      devices: [],
      ownerDevices: [],
      triggers: DEFAULT_TRIGGERS,
      ownerAccess: DEFAULT_OWNER_ACCESS,
      hostUpdates: DEFAULT_HOST_UPDATES,
    };
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.current(), null, 2);
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writing = write.catch(() => {});
    return write;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
