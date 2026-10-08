import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/** What a paired device may reach: a Maestro app gets the full host, a browser only remote control. */
export const remoteDeviceKindSchema = z.enum(['desktop', 'browser']);
export type RemoteDeviceKind = z.infer<typeof remoteDeviceKindSchema>;

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: remoteDeviceKindSchema,
  /** SHA-256 of the device token. The token itself is only ever held by the device. */
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
});

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

const stateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  bindAddress: z.string(),
  hostId: z.string(),
  devices: z.array(deviceSchema),
  triggers: triggersSchema.default(DEFAULT_TRIGGERS),
});

export type RemoteDeviceRecord = z.infer<typeof deviceSchema>;
export type RemoteAccessState = z.infer<typeof stateSchema>;
export type RemoteDevice = Omit<RemoteDeviceRecord, 'tokenHash'>;
export type RemoteTriggers = z.infer<typeof triggersSchema>;

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

  devices(): RemoteDevice[] {
    return this.current().devices.map(({ tokenHash: _tokenHash, ...device }) => device);
  }

  async update(
    patch: Partial<Pick<RemoteAccessState, 'enabled' | 'port' | 'bindAddress'>>
  ): Promise<RemoteAccessState> {
    this.state = stateSchema.parse({ ...this.current(), ...patch });
    await this.persist();
    return this.state;
  }

  /** Registers a device and returns the credential it presents from now on. */
  async addDevice(input: {
    name: string;
    kind: RemoteDeviceKind;
  }): Promise<{ device: RemoteDevice; credential: string }> {
    const token = randomBytes(32).toString('base64url');
    const record: RemoteDeviceRecord = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      tokenHash: hashToken(token),
      createdAt: this.now(),
      lastSeenAt: null,
    };
    const state = this.current();
    this.state = { ...state, devices: [...state.devices, record] };
    await this.persist();
    const { tokenHash: _tokenHash, ...device } = record;
    return { device, credential: `${record.id}.${token}` };
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    const state = this.current();
    const devices = state.devices.filter((device) => device.id !== deviceId);
    if (devices.length === state.devices.length) return false;
    this.state = { ...state, devices };
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
    const record = this.current().devices.find(
      (device) => device.id === credential.slice(0, separator)
    );
    if (!record) return undefined;
    const presented = Buffer.from(hashToken(credential.slice(separator + 1)), 'hex');
    const expected = Buffer.from(record.tokenHash, 'hex');
    if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
      return undefined;
    }
    this.touch(record);
    const { tokenHash: _tokenHash, ...device } = record;
    return device;
  }

  private touch(record: RemoteDeviceRecord): void {
    const now = this.now();
    if (record.lastSeenAt !== null && now - record.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS) return;
    const state = this.current();
    this.state = {
      ...state,
      devices: state.devices.map((device) =>
        device.id === record.id ? { ...device, lastSeenAt: now } : device
      ),
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
      triggers: DEFAULT_TRIGGERS,
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
