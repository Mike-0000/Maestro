import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { HostRef } from '@emdash/core/primitives/host/api';
import type { AttachmentError, AttachmentRef } from '@emdash/core/services/attachments/api';
import { ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { UploadFileValue } from '@emdash/wire/rpc';
import type {
  LocalTerminalFile,
  PreparedTerminalFile,
} from '@core/services/attachments/api/terminal-files';
import {
  prepareTerminalFiles,
  type TerminalFileSources,
} from '@core/services/attachments/node/prepare-terminal-files';

// Rule P, `attachments.prepareLocalFiles` in client mode. The renderer hands over paths it got
// from a drop or a picker, or that `host.persistDroppedBlob` returned. A path that exists on this
// computer is read here and uploaded to the host's attachment store; any other path is the
// host's own (a persisted drop) and is prepared by the host as before. Order is preserved, and a
// failure part-way removes every attachment this call already created.

/** Not the local machine: makes `prepareTerminalFiles` upload every client file. */
const OWNER_HOST_REF: HostRef = { type: 'remote', id: 'owner-host' };

export type MixedFilesOptions<E> = {
  sources: LocalTerminalFile[];
  localFiles: TerminalFileSources;
  /** Whether `path` names a file on this computer. */
  existsLocally?: (path: string) => Promise<boolean>;
  /** The host's own `prepareLocalFiles` for the given sources. */
  forward(sources: LocalTerminalFile[]): Promise<Result<PreparedTerminalFile[], E>>;
  /** The host's `attachments.upload` for this owner (workspace or conversation). */
  upload(file: UploadFileValue): Promise<Result<AttachmentRef, E>>;
  /** The host's `attachments.delete` for this owner; a failure is logged, never returned. */
  remove(attachmentId: string): Promise<Result<unknown, unknown>>;
  signal?: AbortSignal;
  logger: Logger;
};

export async function prepareMixedLocalFiles<E>(
  options: MixedFilesOptions<E>
): Promise<Result<PreparedTerminalFile[], E | AttachmentError>> {
  const existsLocally = options.existsLocally ?? isLocalFile;
  const runs: Array<{ local: boolean; sources: LocalTerminalFile[] }> = [];
  for (const source of options.sources) {
    const local = await existsLocally(source.path);
    const last = runs.at(-1);
    if (last && last.local === local) last.sources.push(source);
    else runs.push({ local, sources: [source] });
  }

  const prepared: PreparedTerminalFile[] = [];
  let completed = false;
  try {
    for (const run of runs) {
      options.signal?.throwIfAborted();
      const result = run.local
        ? await prepareTerminalFiles<E>({
            host: OWNER_HOST_REF,
            sources: run.sources,
            localFiles: options.localFiles,
            upload: options.upload,
            remove: async (attachmentId) => {
              await removeQuietly(attachmentId, options);
              return ok();
            },
            signal: options.signal,
            logger: options.logger,
          })
        : await options.forward(run.sources);
      if (!result.success) return result;
      prepared.push(...result.data);
    }
    completed = true;
    return ok(prepared);
  } finally {
    if (!completed) await rollback(prepared, options);
  }
}

async function rollback<E>(
  prepared: PreparedTerminalFile[],
  options: MixedFilesOptions<E>
): Promise<void> {
  for (const file of prepared) {
    if (file.kind === 'attachment') await removeQuietly(file.id, options);
  }
}

async function removeQuietly<E>(
  attachmentId: string,
  options: MixedFilesOptions<E>
): Promise<void> {
  try {
    const removed = await options.remove(attachmentId);
    if (!removed.success) {
      options.logger.warn('Attachment rollback failed', { error: removed.error });
    }
  } catch (error) {
    options.logger.warn('Attachment rollback failed', { error });
  }
}

async function isLocalFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
