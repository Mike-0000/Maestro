import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export async function launchInstallWorker({ stateRoot, workerPath, job }) {
  if (process.platform !== 'win32')
    throw new Error('The Chorus install worker runs only on Windows.');
  if (!workerPath || !job?.candidateId)
    throw new Error('The packaged Chorus update worker is unavailable.');
  const jobId = job.jobId ?? job.candidateId;
  if (
    typeof jobId !== 'string' ||
    !/^(?:[a-f0-9-]{36}|rollback-[a-f0-9-]{36}-[a-f0-9-]{36})$/.test(jobId)
  ) {
    throw new Error('The Chorus install worker received an invalid job id.');
  }
  job.jobId = jobId;
  await access(workerPath);
  const workerBytes = await readFile(workerPath);
  const workerDigest = createHash('sha256').update(workerBytes).digest('hex');
  job.workerDigest = workerDigest;
  const workerRoot = join(stateRoot, 'Worker');
  const stableWorkerPath = join(workerRoot, `install-chorus-update-${workerDigest}.ps1`);
  await mkdir(workerRoot, { recursive: true });
  try {
    await access(stableWorkerPath);
    const existingDigest = createHash('sha256')
      .update(await readFile(stableWorkerPath))
      .digest('hex');
    if (existingDigest !== workerDigest)
      throw new Error('The preserved install worker failed its content hash check.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const temporaryWorkerPath = `${stableWorkerPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryWorkerPath, workerBytes, { flag: 'wx' });
    try {
      await rename(temporaryWorkerPath, stableWorkerPath);
    } catch (renameError) {
      await unlink(temporaryWorkerPath).catch(() => undefined);
      if (renameError?.code !== 'EEXIST') throw renameError;
    }
  }

  const jobsRoot = join(stateRoot, 'InstallJobs');
  await mkdir(jobsRoot, { recursive: true });
  const jobPath = join(jobsRoot, `${job.candidateId}.json`);
  const pendingPath = `${jobPath}.pending`;
  const temporaryPath = `${jobPath}.${randomUUID()}.tmp`;
  const resultPath = join(stateRoot, 'InstallResults', `${job.candidateId}.json`);
  await Promise.all(
    [jobPath, pendingPath, `${jobPath}.cancelled`, `${jobPath}.applying`, resultPath].map((path) =>
      unlink(path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      })
    )
  );
  await writeFile(temporaryPath, JSON.stringify(job), { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, jobPath);
    await writeFile(pendingPath, `${job.candidateId}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    await unlink(jobPath).catch(() => undefined);
    await unlink(pendingPath).catch(() => undefined);
    throw error;
  }

  const windowsPowerShell = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  try {
    await execFile(
      windowsPowerShell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        stableWorkerPath,
        '-JobPath',
        jobPath,
        '-Bootstrap',
      ],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
  } catch (error) {
    await unlink(jobPath).catch(() => undefined);
    await unlink(pendingPath).catch(() => undefined);
    throw new Error(`Could not start the detached Chorus install worker: ${error.message}`);
  }
  return { jobPath };
}

export async function requestInstallWorkerCancel({ stateRoot, candidateId }) {
  const jobPath = join(stateRoot, 'InstallJobs', `${candidateId}.json`);
  const pendingPath = `${jobPath}.pending`;
  const cancelledPath = `${jobPath}.cancelled`;
  try {
    await rename(pendingPath, cancelledPath);
    return { cancelled: true, alreadyCancelled: false };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try {
        await access(cancelledPath);
        return { cancelled: true, alreadyCancelled: true };
      } catch {
        try {
          await access(`${jobPath}.applying`);
          return { cancelled: false, applying: true };
        } catch {
          throw new Error('The install worker has no cancellable pending request.');
        }
      }
    }
    throw error;
  }
}
