import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireDispatchLease,
  readInstallTargetGate,
  releaseInstallTargetGate,
  reserveInstallTargetGate,
  waitForDispatchLeases,
} from './coordinator/install-target-gate.mjs';
import { requestInstallWorkerCancel } from './coordinator/install-worker.mjs';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chorus-install-target-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local install target gate', () => {
  it('reserves one candidate atomically and treats a duplicate request as idempotent', async () => {
    const stateRoot = await makeRoot();
    const input = {
      stateRoot,
      ownerId: 'owner-a',
      repositoryPath: 'C:/projects/chorus',
      projectId: 'project-a',
      candidateId: 'candidate-a',
      commit: 'a'.repeat(40),
    };

    await expect(reserveInstallTargetGate(input)).resolves.toMatchObject({ owned: true });
    await expect(reserveInstallTargetGate({ ...input, ownerId: 'owner-b' })).resolves.toMatchObject(
      { owned: false, gate: { ownerId: 'owner-a' } }
    );
    await expect(
      reserveInstallTargetGate({ ...input, candidateId: 'candidate-b', ownerId: 'owner-c' })
    ).rejects.toThrow('already reserved by candidate candidate-a');

    await expect(
      releaseInstallTargetGate({
        ...input,
        ownerId: 'owner-b',
      })
    ).resolves.toBe(false);
    await expect(readInstallTargetGate(stateRoot)).resolves.toMatchObject({
      candidateId: 'candidate-a',
    });
    await expect(releaseInstallTargetGate(input)).resolves.toBe(true);
    await expect(readInstallTargetGate(stateRoot)).resolves.toBeNull();
  });

  it('fails closed when the durable gate is malformed', async () => {
    const stateRoot = await makeRoot();
    await writeFile(join(stateRoot, 'install-target-gate.json'), '{broken', 'utf8');
    await expect(readInstallTargetGate(stateRoot)).rejects.toThrow('gate is unreadable');
  });

  it('waits for dispatch leases shared by every Chorus clone', async () => {
    const stateRoot = await makeRoot();
    const release = await acquireDispatchLease({
      stateRoot,
      ownerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    let drained = false;
    const waiting = waitForDispatchLeases(stateRoot, { pollIntervalMs: 5 }).then(() => {
      drained = true;
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(drained).toBe(false);
    release();
    await waiting;
    expect(drained).toBe(true);
  });

  it('wins cancellation only while the worker request is pending', async () => {
    const stateRoot = await makeRoot();
    const jobsRoot = join(stateRoot, 'InstallJobs');
    const jobPath = join(jobsRoot, 'candidate-a.json');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(`${jobPath}.pending`, 'candidate-a\n', 'utf8');

    await expect(
      requestInstallWorkerCancel({ stateRoot, candidateId: 'candidate-a' })
    ).resolves.toMatchObject({ cancelled: true, alreadyCancelled: false });
    await expect(
      requestInstallWorkerCancel({ stateRoot, candidateId: 'candidate-a' })
    ).resolves.toMatchObject({ cancelled: true, alreadyCancelled: true });

    const applyingJobPath = join(jobsRoot, 'candidate-b.json');
    await writeFile(`${applyingJobPath}.pending`, 'candidate-b\n', 'utf8');
    await rename(`${applyingJobPath}.pending`, `${applyingJobPath}.applying`);
    await expect(
      requestInstallWorkerCancel({ stateRoot, candidateId: 'candidate-b' })
    ).resolves.toMatchObject({ cancelled: false, applying: true });
  });
});
