import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { z } from 'zod';
import type { PluginFs } from '#primitives/plugin-fs/api';
import type {
  AddonInstallPayload,
  AddonPartState,
  AgentConfigAddonsError,
  InstalledAddon,
} from '#runtimes/agent-config/api';
import type { AgentConfigAddonsModel } from '#runtimes/agent-config/node/state/live-models';
import { publishLiveModelState } from '#runtimes/agent-config/node/state/live-models';
import type { AgentPluginHost } from '#services/agent-plugins/api/plugins';
import {
  applyInstructionBlock,
  readInstructionBlock,
  removeInstructionBlock,
} from './addon-instructions';

/** Next to the skills manager's own metadata, in the host's home folder. */
const RECEIPTS_PATH = '.agentskills/.emdash/agent-addons.json';

const ADDON_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const receiptSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  providerId: z.string(),
  root: z.string(),
  installedAt: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  instructions: z
    .object({ path: z.string(), sha256: z.string(), createdFile: z.boolean() })
    .optional(),
});
const receiptsFileSchema = z.object({ version: z.literal(1), addons: z.array(receiptSchema) });

type AddonReceipt = z.infer<typeof receiptSchema>;

export type AgentAddonsDeps = {
  /** Home-rooted fs for Maestro's own receipts. */
  homeFs: PluginFs;
  /** Absolute config folder of a provider on this host, such as `~/.claude`. */
  resolveConfigRoot(providerId: string): Promise<Result<string, AgentConfigAddonsError>>;
  /** An fs rooted at a config folder; it refuses paths that escape the root. */
  openFs(root: string): PluginFs;
};

/**
 * Installs add-ons into provider config folders: whole files the add-on owns, plus at most one
 * marked block in a shared instructions file. Receipts record what was written, so an update
 * replaces only Maestro's own unchanged files, removal takes out exactly what was added, and
 * anything the developer edited or wrote themselves is reported as a conflict, not overwritten.
 */
export class AgentAddonsManager {
  private list: InstalledAddon[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: AgentAddonsDeps,
    private readonly model: AgentConfigAddonsModel
  ) {}

  async initialize(): Promise<void> {
    await this.serialized(() => this.refresh());
  }

  install(
    payload: AddonInstallPayload,
    options: { replace?: boolean } = {}
  ): Promise<Result<InstalledAddon[], AgentConfigAddonsError>> {
    return this.serialized(async () => {
      const invalid = validatePayload(payload);
      if (invalid) return err({ type: 'invalid-state', message: invalid });
      const root = await this.deps.resolveConfigRoot(payload.providerId);
      if (!root.success) return root;
      try {
        const fs = this.deps.openFs(root.data);
        const receipts = await this.readReceipts();
        const previous = findReceipt(receipts, payload.providerId, payload.id);
        const sameRoot = previous?.root === root.data ? previous : undefined;

        const conflicts = await findConflicts(fs, payload, sameRoot);
        if (conflicts.length > 0 && !options.replace) {
          await this.refresh();
          return err({ type: 'conflict', paths: conflicts });
        }

        for (const file of payload.files) await fs.write(file.path, file.content);
        if (sameRoot) {
          const kept = new Set(payload.files.map((file) => file.path));
          for (const old of sameRoot.files) {
            if (kept.has(old.path)) continue;
            const current = await fs.read(old.path);
            if (current !== null && digest(current) === old.sha256) await deleteFile(fs, old.path);
          }
        }

        let instructions: AddonReceipt['instructions'];
        if (payload.instructions) {
          const current = await fs.read(payload.instructions.path);
          await fs.write(
            payload.instructions.path,
            applyInstructionBlock(current, payload.id, payload.instructions.content)
          );
          const createdBefore =
            sameRoot?.instructions?.path === payload.instructions.path &&
            sameRoot.instructions.createdFile;
          instructions = {
            path: payload.instructions.path,
            sha256: digest(payload.instructions.content),
            createdFile: current === null || createdBefore === true,
          };
        }
        if (sameRoot?.instructions && sameRoot.instructions.path !== instructions?.path) {
          await removeBlockFrom(fs, sameRoot.instructions, payload.id);
        }
        if (previous && !sameRoot) await removeInstalled(this.deps.openFs(previous.root), previous);

        const receipt: AddonReceipt = {
          id: payload.id,
          version: payload.version,
          providerId: payload.providerId,
          root: root.data,
          installedAt: new Date().toISOString(),
          files: payload.files.map((file) => ({ path: file.path, sha256: digest(file.content) })),
          ...(instructions ? { instructions } : {}),
        };
        await this.writeReceipts([...receipts.filter((entry) => entry !== previous), receipt]);
        return ok(await this.refresh());
      } catch (error) {
        return err(toIoError(error));
      }
    });
  }

  remove(
    providerId: string,
    id: string
  ): Promise<Result<InstalledAddon[], AgentConfigAddonsError>> {
    return this.serialized(async () => {
      try {
        const receipts = await this.readReceipts();
        const receipt = findReceipt(receipts, providerId, id);
        if (!receipt) {
          return err({ type: 'invalid-state', message: `Add-on "${id}" is not installed` });
        }
        await removeInstalled(this.deps.openFs(receipt.root), receipt);
        await this.writeReceipts(receipts.filter((entry) => entry !== receipt));
        return ok(await this.refresh());
      } catch (error) {
        return err(toIoError(error));
      }
    });
  }

  private async refresh(): Promise<InstalledAddon[]> {
    const receipts = await this.readReceipts();
    const installed: InstalledAddon[] = [];
    for (const receipt of receipts)
      installed.push(await describe(this.deps.openFs(receipt.root), receipt));
    const previous = this.list;
    this.list = installed;
    publishLiveModelState(this.model.states.list, installed, previous);
    return installed;
  }

  private async readReceipts(): Promise<AddonReceipt[]> {
    const raw = await this.deps.homeFs.read(RECEIPTS_PATH);
    if (!raw) return [];
    try {
      const parsed = receiptsFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.addons : [];
    } catch {
      return [];
    }
  }

  private async writeReceipts(addons: AddonReceipt[]): Promise<void> {
    await this.deps.homeFs.write(RECEIPTS_PATH, JSON.stringify({ version: 1, addons }, null, 2));
  }

  /** One operation at a time, so two clicks never interleave writes to the same files. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** Resolve a provider's global config folder the way its hook installer does. */
export async function resolveProviderConfigRoot(
  agentHost: Pick<AgentPluginHost, 'get' | 'configRootContext'>,
  providerId: string
): Promise<Result<string, AgentConfigAddonsError>> {
  const plugin = agentHost.get(providerId);
  if (!plugin) return err({ type: 'unknown-provider', providerId });
  const context = await agentHost.configRootContext();
  const root =
    plugin.behavior.hooks?.resolveConfigRoots(context)[0] ??
    plugin.behavior.plugins?.resolveConfigRoot(context);
  if (!root) {
    return err({
      type: 'invalid-state',
      message: `${providerId} has no config folder to install into`,
    });
  }
  return ok(root);
}

function findReceipt(
  receipts: readonly AddonReceipt[],
  providerId: string,
  id: string
): AddonReceipt | undefined {
  return receipts.find((entry) => entry.providerId === providerId && entry.id === id);
}

function validatePayload(payload: AddonInstallPayload): string | null {
  if (!ADDON_ID.test(payload.id)) return `Invalid add-on id: "${payload.id}"`;
  const paths = [...payload.files.map((file) => file.path)];
  if (payload.instructions) paths.push(payload.instructions.path);
  for (const path of paths) {
    if (!isSafeRelativePath(path)) return `Invalid add-on path: "${path}"`;
  }
  if (new Set(paths).size !== paths.length) return 'An add-on lists the same path twice';
  return null;
}

/** Forward-slash relative paths only: no absolute paths, drive letters, or `.`/`..` segments. */
function isSafeRelativePath(path: string): boolean {
  if (path.includes('\\') || path.includes(':') || path.startsWith('/')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function findConflicts(
  fs: PluginFs,
  payload: AddonInstallPayload,
  previous: AddonReceipt | undefined
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const file of payload.files) {
    const current = await fs.read(file.path);
    if (current === null || digest(current) === digest(file.content)) continue;
    const ours = previous?.files.find((entry) => entry.path === file.path);
    if (ours && digest(current) === ours.sha256) continue;
    conflicts.push(file.path);
  }
  if (payload.instructions) {
    const block = readInstructionBlock(await fs.read(payload.instructions.path), payload.id);
    const ours = previous?.instructions;
    const unchanged =
      block === null ||
      digest(block) === digest(payload.instructions.content) ||
      (ours?.path === payload.instructions.path && digest(block) === ours.sha256);
    if (!unchanged) conflicts.push(payload.instructions.path);
  }
  return conflicts;
}

async function describe(fs: PluginFs, receipt: AddonReceipt): Promise<InstalledAddon> {
  const files: InstalledAddon['files'] = [];
  for (const file of receipt.files) {
    files.push({ path: file.path, state: partState(await fs.read(file.path), file.sha256) });
  }
  const instructions = receipt.instructions
    ? {
        path: receipt.instructions.path,
        state: partState(
          readInstructionBlock(await fs.read(receipt.instructions.path), receipt.id),
          receipt.instructions.sha256
        ),
      }
    : undefined;
  return {
    id: receipt.id,
    version: receipt.version,
    providerId: receipt.providerId,
    root: receipt.root,
    installedAt: receipt.installedAt,
    files,
    ...(instructions ? { instructions } : {}),
  };
}

function partState(current: string | null, sha256: string): AddonPartState {
  if (current === null) return 'missing';
  return digest(current) === sha256 ? 'intact' : 'edited';
}

async function removeInstalled(fs: PluginFs, receipt: AddonReceipt): Promise<void> {
  for (const file of receipt.files) await deleteFile(fs, file.path);
  if (receipt.instructions) await removeBlockFrom(fs, receipt.instructions, receipt.id);
}

async function removeBlockFrom(
  fs: PluginFs,
  instructions: NonNullable<AddonReceipt['instructions']>,
  id: string
): Promise<void> {
  const current = await fs.read(instructions.path);
  if (current === null) return;
  const next = removeInstructionBlock(current, id);
  if (next === current) return;
  if (next === '' && instructions.createdFile) await fs.delete(instructions.path);
  else await fs.write(instructions.path, next);
}

/** Delete a file, then the folders it leaves empty, never going above the config root. */
async function deleteFile(fs: PluginFs, path: string): Promise<void> {
  await fs.delete(path);
  const segments = path.split('/').slice(0, -1);
  while (segments.length > 0) {
    const dir = segments.join('/');
    if ((await fs.list(dir)).length > 0) break;
    await fs.delete(dir);
    segments.pop();
  }
}

/** Line endings and surrounding whitespace don't count as an edit. */
function digest(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex');
}

function toIoError(error: unknown): AgentConfigAddonsError {
  return { type: 'io', message: error instanceof Error ? error.message : String(error) };
}
