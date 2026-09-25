import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactAll } from '@emdash/shared/logger';
import { traceEventSchema, type TraceEvent } from '../api/contract';

const FILE = 'interaction-trace.jsonl';
const MAX_BYTES = 2 * 1024 * 1024;

/** Local-only, bounded diagnostic journal. All disk operations are serialized, including deletion. */
export class InteractionDiagnostics {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work, work);
    this.pending = next.catch(() => {});
    return next;
  }

  append(event: TraceEvent, days: number): Promise<void> {
    return this.enqueue(async () => {
      const records = await this.load(days);
      // Redact before serialization to disk; redaction is also applied on every retrieval.
      const safe = traceEventSchema.parse(JSON.parse(redactAll(JSON.stringify(event))));
      records.push(safe);
      await this.save(records);
    });
  }

  read(
    query: { interactionId?: string; since?: string; before?: string; limit: number },
    days: number
  ): Promise<TraceEvent[]> {
    return this.enqueue(async () => {
      const records = await this.load(days);
      // Prune expired records even when no new events arrive.
      await this.save(records);
      return records
        .filter(
          (event) =>
            (!query.interactionId || event.interactionId === query.interactionId) &&
            (!query.since || event.at >= query.since) &&
            (!query.before || event.at < query.before)
        )
        .slice(-query.limit)
        .map((event) => traceEventSchema.parse(JSON.parse(redactAll(JSON.stringify(event)))));
    });
  }

  delete(): Promise<void> {
    return this.enqueue(async () => {
      await rm(join(this.dir, FILE), { force: true });
      await rm(join(this.dir, FILE + '.tmp'), { force: true });
    });
  }

  private async load(days: number): Promise<TraceEvent[]> {
    const path = join(this.dir, FILE);
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size > MAX_BYTES * 2) return [];
    const raw = await readFile(path, 'utf8').catch(() => '');
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return raw.split('\n').flatMap((line) => {
      try {
        const parsed = traceEventSchema.safeParse(JSON.parse(line));
        return parsed.success && parsed.data.at >= cutoff ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  private async save(records: TraceEvent[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.dir, 0o700);
    const lines = records.map((record) => JSON.stringify(record) + '\n');
    let bytes = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const size = Buffer.byteLength(line);
      if (bytes + size > MAX_BYTES) break;
      kept.unshift(line);
      bytes += size;
    }
    const path = join(this.dir, FILE);
    const temp = path + '.tmp';
    await writeFile(temp, kept.join(''), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  }
}
