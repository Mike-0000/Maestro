import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MirrorStatus, WslMirrorInfo, WslMirrorLink } from '../api/types';
import { MirrorSession, type MirrorAgents, type MirrorState } from './mirror-session';
import { createWslMirrorAgents } from './wsl-agents';

/**
 * The mirrors this computer keeps between project folders on a Windows drive and their copies
 * in WSL2 distros. A mirror is remembered across restarts and runs whenever the app does. Its
 * record of what both sides last agreed on is kept beside it, so changes made while the app
 * was closed, deletions included, are still carried over on the next start.
 */

export type WslMirrorServiceDeps = {
  /** Where the list of mirrors and each mirror's record are kept. */
  readonly directory: string;
  readonly log: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
  readonly platform?: NodeJS.Platform;
  /** How the two agents of a mirror are made; replaced in tests. */
  readonly createAgents?: (
    link: WslMirrorLink,
    preserve: readonly string[]
  ) => Promise<MirrorAgents>;
};

/**
 * Files git ignores that a project still needs on both sides. Everything else git ignores is
 * build output or installed dependencies, which each side has to make for itself.
 */
export const DEFAULT_PRESERVE = [
  '.env',
  '.env.*',
  '.envrc',
  '.mcp.json',
  '.claude/settings.local.json',
  '.vscode/settings.json',
];

const STOPPED: MirrorStatus = {
  phase: 'paused',
  files: 0,
  pending: 0,
  lastSyncedAt: null,
  conflicts: [],
  links: 0,
  gitNote: null,
  error: null,
};

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/[\\/]+$/, '')
      .replace(/\//g, '\\')
      .toLowerCase();
  return normalize(a) === normalize(b);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The project's own list of ignored files to carry along, from `.emdash.json`. */
async function projectPreservePatterns(windowsPath: string): Promise<string[]> {
  const config = await readJson<{ preservePatterns?: unknown }>(join(windowsPath, '.emdash.json'));
  const patterns = config?.preservePatterns;
  if (!Array.isArray(patterns)) return [];
  return patterns.filter((pattern): pattern is string => typeof pattern === 'string');
}

export class WslMirrorService {
  private links: WslMirrorLink[] = [];
  private readonly sessions = new Map<string, MirrorSession>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: WslMirrorServiceDeps) {}

  private get supported(): boolean {
    return (
      (this.deps.platform ?? process.platform) === 'win32' || this.deps.createAgents !== undefined
    );
  }

  /** Loads the remembered mirrors and starts the ones that are not paused. */
  start(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.supported) return;
      const stored = await readJson<{ links?: WslMirrorLink[] }>(this.linksFile());
      this.links = Array.isArray(stored?.links) ? stored.links : [];
      for (const link of this.links) if (!link.paused) this.run(link);
    })();
    return this.loaded;
  }

  async list(): Promise<WslMirrorInfo[]> {
    await this.start();
    return this.links.map((link) => this.info(link));
  }

  /**
   * Starts mirroring a Windows folder with its copy in a distro, or returns the mirror that
   * already does. The first run makes the copy match the Windows folder.
   */
  async create(input: {
    name: string;
    windowsPath: string;
    distro: string;
    linuxPath: string;
    machineId?: string;
  }): Promise<WslMirrorInfo> {
    await this.start();
    if (!this.supported) throw new Error('WSL mirrors exist only on Windows.');
    const existing = this.links.find((link) => samePath(link.windowsPath, input.windowsPath));
    if (existing) {
      if (
        existing.distro.toLowerCase() !== input.distro.toLowerCase() ||
        existing.linuxPath !== input.linuxPath
      ) {
        throw new Error(
          `This folder is already mirrored to ${existing.linuxPath} in ${existing.distro}. Stop that mirror first.`
        );
      }
      if (existing.paused) return this.setPaused(existing.id, false);
      return this.info(existing);
    }
    const link: WslMirrorLink = {
      id: randomUUID(),
      name: input.name,
      windowsPath: input.windowsPath,
      distro: input.distro,
      linuxPath: input.linuxPath,
      machineId: input.machineId ?? null,
      paused: false,
      seeded: false,
      createdAt: Date.now(),
    };
    this.links = [...this.links, link];
    await this.saveLinks();
    this.run(link);
    return this.info(link);
  }

  async setPaused(id: string, paused: boolean): Promise<WslMirrorInfo> {
    await this.start();
    const link = this.require(id);
    if (link.paused !== paused) {
      const next = this.update(id, { paused });
      await this.saveLinks();
      if (paused) await this.halt(id);
      else this.run(next);
    }
    return this.info(this.require(id));
  }

  /** Stops a mirror for good. Both folders stay as they are. */
  async remove(id: string): Promise<void> {
    await this.start();
    this.require(id);
    await this.halt(id);
    this.links = this.links.filter((link) => link.id !== id);
    await this.saveLinks();
    await rm(this.stateFile(id), { force: true });
  }

  async syncNow(id: string): Promise<WslMirrorInfo> {
    await this.start();
    this.sessions.get(id)?.syncNow();
    return this.info(this.require(id));
  }

  /**
   * Resolves once both sides agree. A mirror that cannot start yet (the distro's workspace
   * server may still be installing) keeps trying, so this waits through that until the
   * deadline.
   */
  async waitUntilSynced(id: string, timeoutMs: number): Promise<WslMirrorInfo> {
    await this.start();
    const deadline = Date.now() + timeoutMs;
    let lastError = 'The mirror did not finish in time.';
    while (Date.now() < deadline) {
      const session = this.sessions.get(id);
      if (!session) throw new Error('The mirror is paused.');
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          session.whenSynced(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(lastError)),
              Math.max(0, deadline - Date.now())
            );
          }),
        ]);
        return this.info(this.require(id));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error(lastError);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.halt(id)));
    await this.saving;
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private linksFile(): string {
    return join(this.deps.directory, 'mirrors.json');
  }

  private stateFile(id: string): string {
    return join(this.deps.directory, `${id}.state.json`);
  }

  private require(id: string): WslMirrorLink {
    const link = this.links.find((candidate) => candidate.id === id);
    if (!link) throw new Error('That WSL mirror no longer exists.');
    return link;
  }

  private update(id: string, patch: Partial<WslMirrorLink>): WslMirrorLink {
    const next = { ...this.require(id), ...patch };
    this.links = this.links.map((link) => (link.id === id ? next : link));
    return next;
  }

  private info(link: WslMirrorLink): WslMirrorInfo {
    return { ...link, status: this.sessions.get(link.id)?.status() ?? STOPPED };
  }

  private saveLinks(): Promise<void> {
    const write = async () => {
      await mkdir(this.deps.directory, { recursive: true });
      await writeJson(this.linksFile(), { version: 1, links: this.links });
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }

  private run(link: WslMirrorLink): void {
    if (this.disposed || this.sessions.has(link.id)) return;
    const id = link.id;
    const session = new MirrorSession({
      seed: !link.seeded,
      createAgents: async () => {
        const current = this.require(id);
        const preserve = [
          ...DEFAULT_PRESERVE,
          ...(await projectPreservePatterns(current.windowsPath)),
        ];
        return this.deps.createAgents
          ? this.deps.createAgents(current, preserve)
          : createWslMirrorAgents({ ...current, preserve });
      },
      loadState: () => readJson<MirrorState>(this.stateFile(id)),
      saveState: async (state) => {
        await mkdir(this.deps.directory, { recursive: true });
        await writeJson(this.stateFile(id), state);
      },
      onSeeded: async () => {
        if (!this.links.some((candidate) => candidate.id === id)) return;
        this.update(id, { seeded: true });
        await this.saveLinks();
      },
      log: {
        info: (message, data) => this.deps.log.info(message, { mirror: link.name, ...data }),
        warn: (message, data) => this.deps.log.warn(message, { mirror: link.name, ...data }),
      },
    });
    this.sessions.set(id, session);
    session.start();
  }

  private async halt(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.stop();
  }
}
