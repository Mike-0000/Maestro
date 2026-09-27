import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_BUILD_CHECKS } from './coordinator/build-validation.mjs';
import { createCoordinator } from './coordinator/coordinator.mjs';

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'chorus-delivery-'));
  temporaryDirectories.push(root);
  const repositoryPath = join(root, 'repo');
  const worktreePath = join(root, 'task-a');
  await mkdir(repositoryPath);
  await git(repositoryPath, ['init', '--initial-branch=main']);
  await git(repositoryPath, ['config', 'user.name', 'Chorus Delivery Test']);
  await git(repositoryPath, ['config', 'user.email', 'chorus-delivery-test@example.invalid']);
  await writeFile(join(repositoryPath, 'README.md'), 'base\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'initial']);
  const base = await git(repositoryPath, ['rev-parse', 'HEAD']);
  await git(repositoryPath, ['worktree', 'add', '-b', 'agent/a', worktreePath, base]);
  let beforeValidation: (() => Promise<void>) | undefined;
  let failValidationWith: string | null = null;
  const coordinator = createCoordinator({
    stateRoot: join(root, 'state'),
    runValidation: async ({ candidate }) => {
      await beforeValidation?.();
      if (failValidationWith) throw new Error(failValidationWith);
      return {
        integratedCommit: candidate.commit as string,
        checks: [...REQUIRED_BUILD_CHECKS],
        artifactDigest: 'a'.repeat(64),
        manifestPath: join(root, 'state', 'test-build-manifest.json'),
        buildId: 'test-build',
        artifactRoot: join(root, 'state', 'test-artifact'),
        toolchain: { node: '24.14.0', pnpm: '10.28.2' },
        checkedAt: new Date().toISOString(),
      };
    },
  });
  await coordinator.configure({
    repositoryPath,
    projectId: 'project-a',
    mainRef: 'refs/heads/main',
  });
  await coordinator.join({
    repositoryPath,
    projectId: 'project-a',
    taskId: 'task-a',
    taskName: 'First change',
    worktreePath,
  });
  return {
    root,
    repositoryPath,
    worktreePath,
    base,
    coordinator,
    setBeforeValidation(callback: () => Promise<void>) {
      beforeValidation = callback;
    },
    failValidation(message: string) {
      failValidationWith = message;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('persistent Chorus delivery coordinator', () => {
  it('identifies linked worktrees as one repository coordinator', async () => {
    const fixture = await createFixture();
    const second = join(fixture.root, 'task-b');
    await git(fixture.repositoryPath, ['worktree', 'add', '-b', 'agent/b', second, fixture.base]);

    const firstIdentity = await fixture.coordinator.repositoryIdentity(fixture.repositoryPath);
    const secondIdentity = await fixture.coordinator.repositoryIdentity(second);

    expect(secondIdentity.repositoryId).toBe(firstIdentity.repositoryId);
    expect(secondIdentity.gitCommonDir).toBe(firstIdentity.gitCommonDir);
  });

  it('keeps a following candidate immutable and invalidates it when a later task joins', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'first change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'First feature',
    });

    const candidate = await fixture.coordinator.prepare({
      repositoryPath: fixture.repositoryPath,
      policy: 'follow-project',
    });
    expect(candidate).toMatchObject({ state: 'integrated', commit: expect.any(String) });
    await fixture.coordinator.validateCandidate({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });

    const second = join(fixture.root, 'task-b');
    await git(fixture.repositoryPath, ['worktree', 'add', '-b', 'agent/b', second, fixture.base]);
    await fixture.coordinator.join({
      repositoryPath: fixture.repositoryPath,
      projectId: 'project-a',
      taskId: 'task-b',
      taskName: 'Later change',
      worktreePath: second,
    });

    const status = await fixture.coordinator.status(fixture.repositoryPath);
    expect(status.candidate?.commit).toBe(candidate.commit);
    expect(status.candidate?.eligible).toBe(false);
    await expect(
      fixture.coordinator.schedule({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
        restartPolicy: 'manual',
      })
    ).rejects.toThrow('project changed');
  });

  it('requires a fresh handoff after coding resumes while retaining the earlier pinned SHA', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'first change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'First feature',
    });
    await fixture.coordinator.invalidate({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
    });

    const status = await fixture.coordinator.status(fixture.repositoryPath);
    expect(status.tasks[0]).toMatchObject({ state: 'working', commit: null, revision: 1 });
    await expect(
      fixture.coordinator.prepare({
        repositoryPath: fixture.repositoryPath,
        policy: 'follow-project',
      })
    ).rejects.toThrow('waiting for');
    const taskHash = createHash('sha256').update('task-a').digest('hex').slice(0, 24);
    expect(
      await git(fixture.repositoryPath, [
        'rev-parse',
        `refs/chorus/delivery/${status.repositoryId.slice(0, 16)}/${taskHash}/${commit}`,
      ])
    ).toBe(commit);
  });

  it('withdraws archived unfinished work so it no longer blocks following the project', async () => {
    const fixture = await createFixture();
    const second = join(fixture.root, 'task-b');
    await git(fixture.repositoryPath, ['worktree', 'add', '-b', 'agent/b', second, fixture.base]);
    await fixture.coordinator.join({
      repositoryPath: fixture.repositoryPath,
      projectId: 'project-a',
      taskId: 'task-b',
      taskName: 'Abandoned change',
      worktreePath: second,
    });
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'first change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'First feature',
    });
    await expect(
      fixture.coordinator.prepare({
        repositoryPath: fixture.repositoryPath,
        policy: 'follow-project',
      })
    ).rejects.toThrow('Abandoned change');

    // Archiving finished work keeps its handoff; archiving unfinished work withdraws it.
    const kept = await fixture.coordinator.retire({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      reason: 'archived',
    });
    const withdrawn = await fixture.coordinator.retire({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-b',
      reason: 'archived',
    });
    const repeated = await fixture.coordinator.retire({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-b',
      reason: 'archived',
    });
    const unknown = await fixture.coordinator.retire({
      repositoryPath: fixture.repositoryPath,
      taskId: 'never-enrolled',
      reason: 'deleted',
    });

    expect(kept.withdrawn).toBe(false);
    expect(withdrawn.withdrawn).toBe(true);
    expect(repeated.withdrawn).toBe(false);
    expect(unknown.withdrawn).toBe(false);
    const status = await fixture.coordinator.status(fixture.repositoryPath);
    expect(status.generation).toBe(repeated.generation);
    expect(status.tasks).toEqual([
      expect.objectContaining({ taskId: 'task-a', state: 'submitted', withdrawnReason: null }),
      expect.objectContaining({
        taskId: 'task-b',
        state: 'withdrawn',
        withdrawnReason: 'archived',
      }),
    ]);
    const candidate = await fixture.coordinator.prepare({
      repositoryPath: fixture.repositoryPath,
      policy: 'follow-project',
    });
    expect(candidate.included).toEqual([expect.objectContaining({ taskId: 'task-a', commit })]);
  });

  it('rejoins a restored task but keeps an explicit withdrawal until it rejoins explicitly', async () => {
    const fixture = await createFixture();
    const task = {
      repositoryPath: fixture.repositoryPath,
      projectId: 'project-a',
      taskId: 'task-a',
      taskName: 'First change',
      worktreePath: fixture.worktreePath,
    };
    await fixture.coordinator.retire({ ...task, reason: 'archived' });

    const rejoined = await fixture.coordinator.join(task);
    const afterRestore = await fixture.coordinator.status(fixture.repositoryPath);
    expect(rejoined).toMatchObject({ result: { joined: true, rejoined: true } });
    expect(afterRestore.tasks[0]).toMatchObject({
      state: 'working',
      withdrawnReason: null,
      revision: 1,
    });

    await fixture.coordinator.withdraw(task);
    const ignored = await fixture.coordinator.join(task);
    await fixture.coordinator.invalidate(task);
    const afterExplicit = await fixture.coordinator.status(fixture.repositoryPath);
    expect(ignored).toMatchObject({ result: { joined: false } });
    expect(afterExplicit.tasks[0]).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: 'explicit',
    });
  });

  it('serializes a late join during validation ahead of a following candidate apply', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'first change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'First feature',
    });
    const candidate = await fixture.coordinator.prepare({
      repositoryPath: fixture.repositoryPath,
      policy: 'follow-project',
    });
    const second = join(fixture.root, 'task-b');
    await git(fixture.repositoryPath, ['worktree', 'add', '-b', 'agent/b', second, fixture.base]);
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    fixture.setBeforeValidation(async () => {
      validationStarted();
      await validationGate;
    });
    const validation = fixture.coordinator.validateCandidate({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await started;
    await fixture.coordinator.join({
      repositoryPath: fixture.repositoryPath,
      projectId: 'project-a',
      taskId: 'task-b',
      taskName: 'Late change',
      worktreePath: second,
    });
    releaseValidation();
    await validation;
    await expect(
      fixture.coordinator.schedule({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
        restartPolicy: 'manual',
      })
    ).rejects.toThrow('project changed');
  });

  it('rejects a handoff while source changes remain uncommitted', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'untracked.ts'), 'const source = true;\n');
    const head = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);

    await expect(
      fixture.coordinator.submit({
        repositoryPath: fixture.repositoryPath,
        taskId: 'task-a',
        commit: head,
        base: fixture.base,
        summary: 'Uncommitted source',
      })
    ).rejects.toThrow('worktree is clean');
  });

  it('preserves and reports a cumulative merge conflict in its coordinator worktree', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'README.md'), 'task a\n');
    await git(fixture.worktreePath, ['add', 'README.md']);
    await git(fixture.worktreePath, ['commit', '-m', 'task a']);
    const commitA = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit: commitA,
      base: fixture.base,
      summary: 'README update A',
    });

    const second = join(fixture.root, 'task-b');
    await git(fixture.repositoryPath, ['worktree', 'add', '-b', 'agent/b', second, fixture.base]);
    await fixture.coordinator.join({
      repositoryPath: fixture.repositoryPath,
      projectId: 'project-a',
      taskId: 'task-b',
      taskName: 'Second change',
      worktreePath: second,
    });
    await writeFile(join(second, 'README.md'), 'task b\n');
    await git(second, ['add', 'README.md']);
    await git(second, ['commit', '-m', 'task b']);
    const commitB = await git(second, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-b',
      commit: commitB,
      base: fixture.base,
      summary: 'README update B',
    });

    const candidate = await fixture.coordinator.prepare({
      repositoryPath: fixture.repositoryPath,
      taskIds: ['task-a', 'task-b'],
    });
    expect(candidate).toMatchObject({ state: 'blocked', error: expect.any(String) });
    const conflict = await readFile(join(candidate.worktreePath, 'README.md'), 'utf8');
    expect(conflict).toContain('<<<<<<<');
  });

  it('records a validation failure on the candidate and lastError', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'ready\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'ready change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'Ready change',
    });
    const candidate = await fixture.coordinator.prepare({
      repositoryPath: fixture.repositoryPath,
      policy: 'snapshot',
    });
    fixture.failValidation('workspace-static-check failed: format');
    await expect(
      fixture.coordinator.validateCandidate({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
      })
    ).resolves.toMatchObject({
      validated: false,
      state: 'blocked',
      error: 'workspace-static-check failed: format',
    });
    const status = await fixture.coordinator.status(fixture.repositoryPath);
    expect(status.candidate).toMatchObject({
      state: 'blocked',
      error: 'workspace-static-check failed: format',
      validation: { error: 'workspace-static-check failed: format' },
    });
    expect(status.lastError).toBe('workspace-static-check failed: format');
  });

  it('promotes only a validated fast-forward on a clean canonical branch', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'ready\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'ready change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'Ready change',
    });
    const candidate = await fixture.coordinator.prepare({
      repositoryPath: fixture.repositoryPath,
      policy: 'snapshot',
    });
    await fixture.coordinator.validateCandidate({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });

    const promoted = await fixture.coordinator.promote({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    const status = await fixture.coordinator.status(fixture.repositoryPath);

    expect(promoted).toMatchObject({
      result: { promoted: true, commit: candidate.commit },
    });
    expect(await git(fixture.repositoryPath, ['rev-parse', 'refs/heads/main'])).toBe(
      candidate.commit
    );
    expect(status.candidate).toMatchObject({
      state: 'promoted',
      githubBackup: { state: 'pending' },
    });
    expect(status.tasks[0]?.state).toBe('integrated');
    await expect(
      fixture.coordinator.schedule({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
        restartPolicy: 'manual',
      })
    ).resolves.toMatchObject({ result: { scheduled: true } });
  });

  it('serializes integration work and supports idempotent scheduling and pre-replacement cancel', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'ready\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'ready change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'Ready change',
    });
    const candidate = await fixture.coordinator.prepare({ repositoryPath: fixture.repositoryPath });

    let finishValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolveStarted) => {
      markValidationStarted = resolveStarted;
    });
    fixture.setBeforeValidation(
      () =>
        new Promise<void>((resolveValidation) => {
          finishValidation = resolveValidation;
          markValidationStarted();
        })
    );
    const validating = fixture.coordinator.validateCandidate({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await validationStarted;
    await expect(
      fixture.coordinator.prepare({ repositoryPath: fixture.repositoryPath })
    ).rejects.toThrow('integration/build worker is busy');
    finishValidation();
    await expect(validating).resolves.toMatchObject({ validated: true });

    await fixture.coordinator.promote({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await expect(
      fixture.coordinator.schedule({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
        restartPolicy: 'manual',
      })
    ).resolves.toMatchObject({ result: { scheduled: true } });
    await expect(
      fixture.coordinator.schedule({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
        restartPolicy: 'manual',
      })
    ).resolves.toMatchObject({ result: { scheduled: true, alreadyScheduled: true } });
    await fixture.coordinator.beginApply({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await fixture.coordinator.cancelApply({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });

    const status = await fixture.coordinator.status(fixture.repositoryPath);
    expect(status.applyingCandidateId).toBeNull();
    expect(status.candidate).toBeNull();
    expect(await git(fixture.repositoryPath, ['rev-parse', 'refs/heads/main'])).toBe(
      candidate.commit
    );
  });

  it('requires compatible retained build health for rollback and records verified restoration', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'ready\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'ready change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'Ready change',
    });
    const candidate = await fixture.coordinator.prepare({ repositoryPath: fixture.repositoryPath });
    await fixture.coordinator.validateCandidate({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    const validatedCandidate = (await fixture.coordinator.status(fixture.repositoryPath)).candidate;
    if (!validatedCandidate?.validation) throw new Error('Expected a validated package manifest.');
    await fixture.coordinator.promote({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await fixture.coordinator.schedule({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
      restartPolicy: 'manual',
    });
    await fixture.coordinator.beginApply({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    const previousBuild = {
      deliveryProtocol: 1,
      commit: 'a'.repeat(40),
      buildId: '11111111-1111-4111-8111-111111111111',
      version: '1.0.0',
    };
    await fixture.coordinator.finishApply({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
      health: {
        commit: candidate.commit,
        artifactDigest: validatedCandidate.validation.artifactDigest,
        buildId: validatedCandidate.validation.buildId,
        readyAt: '2026-09-26T12:00:00.000Z',
        backupRoot: 'C:/Programs/Chorus.backup',
        previousBuild,
      },
    });
    // A matched startup receipt completes the isolated coordinator flow; no real app is replaced.
    expect(await fixture.coordinator.status(fixture.repositoryPath)).toMatchObject({
      installedCandidateId: candidate.id,
      applyingCandidateId: null,
      candidate: { state: 'installed' },
    });

    await fixture.coordinator.beginRollback({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await fixture.coordinator.markRollbackNeedsRecovery({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
      error: 'The worker stopped after replacement began.',
    });
    expect(await fixture.coordinator.status(fixture.repositoryPath)).toMatchObject({
      applyingCandidateId: candidate.id,
      candidate: { state: 'rolling-back', error: 'The worker stopped after replacement began.' },
    });

    await fixture.coordinator.finishRollback({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
      health: {
        commit: previousBuild.commit,
        buildId: previousBuild.buildId,
        readyAt: '2026-09-26T12:00:00.000Z',
      },
    });
    expect(await fixture.coordinator.status(fixture.repositoryPath)).toMatchObject({
      applyingCandidateId: null,
      installedCandidateId: null,
      candidate: { state: 'rolled-back', rollbackHealth: { commit: previousBuild.commit } },
    });
  });

  it('refuses promotion when the canonical worktree contains user changes', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, 'feature.txt'), 'ready\n');
    await git(fixture.worktreePath, ['add', 'feature.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'ready change']);
    const commit = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await fixture.coordinator.submit({
      repositoryPath: fixture.repositoryPath,
      taskId: 'task-a',
      commit,
      base: fixture.base,
      summary: 'Ready change',
    });
    const candidate = await fixture.coordinator.prepare({ repositoryPath: fixture.repositoryPath });
    await fixture.coordinator.validateCandidate({
      repositoryPath: fixture.repositoryPath,
      candidateId: candidate.id,
    });
    await writeFile(join(fixture.repositoryPath, 'local-note.txt'), 'keep this file\n');

    await expect(
      fixture.coordinator.promote({
        repositoryPath: fixture.repositoryPath,
        candidateId: candidate.id,
      })
    ).rejects.toThrow('local changes');
    expect(await git(fixture.repositoryPath, ['rev-parse', 'refs/heads/main'])).toBe(fixture.base);
    expect(await readFile(join(fixture.repositoryPath, 'local-note.txt'), 'utf8')).toBe(
      'keep this file\n'
    );
  });
});
