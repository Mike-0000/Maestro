import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

/**
 * A small JSON settings file in the Chorus data directory. Chorus keeps its own settings out of
 * the Emdash settings registry and database so the fork adds no migrations upstream would collide
 * with.
 */
export class JsonSettingsFile<T extends object> {
  private cached: T | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly defaults: T
  ) {}

  static inDir<T extends object>(
    dataDir: string,
    fileName: string,
    schema: z.ZodType<T>,
    defaults: T
  ): JsonSettingsFile<T> {
    return new JsonSettingsFile(join(dataDir, fileName), schema, defaults);
  }

  async read(): Promise<T> {
    if (this.cached) return this.cached;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      const merged = { ...this.defaults, ...(raw as object) };
      const parsed = this.schema.safeParse(merged);
      this.cached = parsed.success ? parsed.data : this.defaults;
    } catch {
      this.cached = this.defaults;
    }
    return this.cached;
  }

  async update(patch: Partial<T>): Promise<T> {
    // Read, merge and write one update at a time. Two updates in flight together (for example
    // two settings saves a remote client sends in one batch) would otherwise both merge into the
    // same snapshot, and the later write would drop the earlier update's fields. Each file
    // replace is atomic, so a crash never leaves a torn file.
    const run = this.writeChain.then(async () => {
      const next = this.schema.parse({ ...(await this.read()), ...patch });
      this.cached = next;
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
      await rename(temp, this.path);
      return next;
    });
    // A failed update rejects only its own caller; the next update still runs.
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
