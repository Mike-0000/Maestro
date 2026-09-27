import { randomUUID } from 'node:crypto';
import { open, readFile, unlink, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GATE_FILE = 'install-target-gate.json';
const DISPATCH_LEASES_DIRECTORY = 'DispatchLeases';

export async function readInstallTargetGate(stateRoot) {
  const path = join(stateRoot, GATE_FILE);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let gate;
  try {
    gate = JSON.parse(raw);
  } catch {
    throw new Error('The Chorus install target gate is unreadable; recover it before new work.');
  }
  if (
    gate?.version !== 1 ||
    typeof gate.ownerId !== 'string' ||
    typeof gate.repositoryPath !== 'string' ||
    typeof gate.projectId !== 'string' ||
    typeof gate.candidateId !== 'string' ||
    typeof gate.commit !== 'string' ||
    typeof gate.createdAt !== 'string'
  ) {
    throw new Error('The Chorus install target gate is invalid; recover it before new work.');
  }
  return gate;
}

export async function reserveInstallTargetGate({
  stateRoot,
  ownerId,
  repositoryPath,
  projectId,
  candidateId,
  commit,
}) {
  await mkdir(stateRoot, { recursive: true });
  const path = join(stateRoot, GATE_FILE);
  const gate = {
    version: 1,
    ownerId,
    repositoryPath: resolve(repositoryPath),
    projectId,
    candidateId,
    commit,
    phase: 'preparing',
    createdAt: new Date().toISOString(),
  };
  let opened;
  try {
    const file = await open(path, 'wx', 0o600);
    opened = true;
    try {
      await file.writeFile(JSON.stringify(gate), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    return { owned: true, gate };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      if (opened) await unlink(path).catch(() => undefined);
      throw error;
    }
    const existing = await readInstallTargetGate(stateRoot);
    if (
      existing &&
      samePath(existing.repositoryPath, repositoryPath) &&
      existing.candidateId === candidateId
    ) {
      return { owned: false, gate: existing };
    }
    throw new Error(
      existing
        ? `Chorus install target is already reserved by candidate ${existing.candidateId}.`
        : 'Chorus install target is being reserved; try again shortly.'
    );
  }
}

export async function releaseInstallTargetGate({
  stateRoot,
  ownerId,
  repositoryPath,
  candidateId,
}) {
  const existing = await readInstallTargetGate(stateRoot);
  if (!existing) return false;
  if (
    existing.ownerId !== ownerId ||
    existing.candidateId !== candidateId ||
    !samePath(existing.repositoryPath, repositoryPath)
  ) {
    return false;
  }
  await unlink(join(stateRoot, GATE_FILE));
  return true;
}

export async function acquireDispatchLease({ stateRoot, ownerId }) {
  const leasesRoot = join(stateRoot, DISPATCH_LEASES_DIRECTORY);
  await mkdir(leasesRoot, { recursive: true });
  const path = join(leasesRoot, `${process.pid}-${ownerId}-${randomUUID()}.json`);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(
      JSON.stringify({
        version: 1,
        ownerId,
        processId: process.pid,
        createdAt: new Date().toISOString(),
      }),
      'utf8'
    );
    await file.sync();
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void unlink(path).catch(() => undefined);
  };
}

export async function waitForDispatchLeases(stateRoot, { pollIntervalMs = 100 } = {}) {
  const leasesRoot = join(stateRoot, DISPATCH_LEASES_DIRECTORY);
  for (;;) {
    let entries;
    try {
      entries = await readdir(leasesRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    let active = false;
    for (const entry of entries) {
      const match = /^(\d+)-[a-f0-9-]+-[a-f0-9-]+\.json$/i.exec(entry);
      if (!match) throw new Error(`Unrecognized Chorus dispatch lease: ${entry}`);
      const processId = Number(match[1]);
      if (!Number.isSafeInteger(processId) || processId <= 0) {
        throw new Error(`Invalid process id in Chorus dispatch lease: ${entry}`);
      }
      try {
        process.kill(processId, 0);
        active = true;
      } catch (error) {
        if (error?.code === 'ESRCH') {
          await unlink(join(leasesRoot, entry)).catch((unlinkError) => {
            if (unlinkError?.code !== 'ENOENT') throw unlinkError;
          });
        } else if (error?.code === 'EPERM') {
          active = true;
        } else {
          throw error;
        }
      }
    }
    if (!active) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
