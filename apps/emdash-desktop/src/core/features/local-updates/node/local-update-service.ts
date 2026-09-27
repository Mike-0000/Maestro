import { randomUUID } from 'node:crypto';
import { access, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '@emdash/shared/logger';
import { and, eq, isNull } from 'drizzle-orm';
import {
  liveWorkspaces,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import type { ActiveSessionSummary } from '@core/primitives/desktop-host/api/host-contract';
import type { Task } from '@core/primitives/tasks/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';
import type { LocalUpdateStatus } from '../api';
import { createCoordinator, defaultStateRoot } from './coordinator/coordinator.mjs';
import {
  acquireDispatchLease,
  readInstallTargetGate,
  releaseInstallTargetGate,
  reserveInstallTargetGate,
  waitForDispatchLeases as waitForSharedDispatchLeases,
} from './coordinator/install-target-gate.mjs';
import { launchInstallWorker, requestInstallWorkerCancel } from './coordinator/install-worker.mjs';

type Coordinator = ReturnType<typeof createCoordinator>;

export function createLocalUpdateService(
  db: AppDb,
  host: ChorusHostServices,
  dependencies: { getActiveSessionSummary(): Promise<ActiveSessionSummary> }
) {
  const coordinator: Coordinator = createCoordinator();
  const stateRoot = defaultStateRoot();
  const processOwnerId = randomUUID();
  let activeDispatchLeases = 0;
  const dispatchDrainWaiters = new Set<() => void>();

  function createDispatchLease(): () => void {
    activeDispatchLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeDispatchLeases -= 1;
      if (activeDispatchLeases === 0) {
        for (const resolve of dispatchDrainWaiters) resolve();
        dispatchDrainWaiters.clear();
      }
    };
  }

  async function waitForDispatchLeases(): Promise<void> {
    if (activeDispatchLeases > 0) {
      await new Promise<void>((resolveWait) => dispatchDrainWaiters.add(resolveWait));
    }
    await waitForSharedDispatchLeases(stateRoot);
  }

  async function assertInstallTargetAvailable(): Promise<void> {
    const gate = await readInstallTargetGate(stateRoot);
    if (gate) {
      throw new Error(
        `Chorus installation is reserved for candidate ${gate.candidateId}; new sessions are paused.`
      );
    }
  }

  async function completeInstallResults(repositoryPath: string): Promise<void> {
    const resultRoot = join(stateRoot, 'InstallResults');
    const files = await readdir(resultRoot).catch(() => []);
    const status = await coordinator.status(repositoryPath);
    const gate = await readInstallTargetGate(stateRoot);
    const sameRepository =
      gate &&
      resolve(gate.repositoryPath).toLocaleLowerCase() ===
        resolve(repositoryPath).toLocaleLowerCase();
    const cancelledMarker = gate
      ? join(stateRoot, 'InstallJobs', `${gate.candidateId}.json.cancelled`)
      : null;
    const hasCancelledMarker = cancelledMarker
      ? await access(cancelledMarker).then(
          () => true,
          () => false
        )
      : false;
    if (
      gate &&
      sameRepository &&
      !status.applyingCandidateId &&
      (status.installedCandidateId === gate.candidateId ||
        status.candidate?.state === 'failed' ||
        status.candidate?.state === 'cancelled' ||
        status.candidate?.state === 'rolled-back' ||
        hasCancelledMarker)
    ) {
      await releaseInstallTargetGate({
        stateRoot,
        ownerId: gate.ownerId,
        repositoryPath,
        candidateId: gate.candidateId,
      });
      return;
    }
    if (
      gate &&
      sameRepository &&
      !status.applyingCandidateId &&
      gate.ownerId !== processOwnerId &&
      status.candidate?.id === gate.candidateId &&
      ['promoted', 'scheduled'].includes(status.candidate.state) &&
      !(await access(join(stateRoot, 'InstallJobs', `${gate.candidateId}.json`)).then(
        () => true,
        () => false
      ))
    ) {
      await releaseInstallTargetGate({
        stateRoot,
        ownerId: gate.ownerId,
        repositoryPath,
        candidateId: gate.candidateId,
      });
      return;
    }
    if (!status.applyingCandidateId) return;
    const cancellationPath = join(
      stateRoot,
      'InstallJobs',
      `${status.applyingCandidateId}.json.cancelled`
    );
    if (
      await access(cancellationPath).then(
        () => true,
        () => false
      )
    ) {
      await coordinator.cancelApply({
        repositoryPath,
        candidateId: status.applyingCandidateId,
      });
      const cancelledGate = await readInstallTargetGate(stateRoot);
      if (cancelledGate?.candidateId === status.applyingCandidateId && sameRepository) {
        await releaseInstallTargetGate({
          stateRoot,
          ownerId: cancelledGate.ownerId,
          repositoryPath,
          candidateId: cancelledGate.candidateId,
        });
      }
      return;
    }
    for (const file of files.filter((entry) => entry.endsWith('.json'))) {
      const result = await readFile(join(resultRoot, file), 'utf8')
        .then(
          (value) =>
            JSON.parse(value) as {
              status?:
                | 'installed'
                | 'failed'
                | 'cancelled'
                | 'rolled-back'
                | 'rollback-failed'
                | 'rollback-needs-recovery'
                | 'install-needs-recovery';
              candidateId?: string;
              repositoryPath?: string;
              health?: Record<string, unknown>;
              error?: string;
            }
        )
        .catch(() => null);
      if (
        !result ||
        result.candidateId !== status.applyingCandidateId ||
        !result.repositoryPath ||
        resolve(result.repositoryPath).toLocaleLowerCase() !==
          resolve(repositoryPath).toLocaleLowerCase()
      )
        continue;
      if (result.status === 'installed' && result.health) {
        await coordinator.finishApply({
          repositoryPath,
          candidateId: result.candidateId,
          health: result.health,
        });
      } else if (result.status === 'failed') {
        await coordinator.failCandidate({
          repositoryPath,
          candidateId: result.candidateId,
          error: result.error ?? 'The install worker failed without an error summary.',
        });
      } else if (result.status === 'install-needs-recovery') {
        const recoveryError =
          result.error ?? 'Install replacement stopped before recovery could be verified.';
        if (
          status.candidate?.state !== 'recovery-required' ||
          status.candidate.error !== recoveryError
        ) {
          await coordinator.markCandidateNeedsRecovery({
            repositoryPath,
            candidateId: result.candidateId,
            error: recoveryError,
          });
        }
        return;
      } else if (result.status === 'cancelled') {
        await coordinator.cancelApply({ repositoryPath, candidateId: result.candidateId });
      } else if (result.status === 'rolled-back' && result.health) {
        await coordinator.finishRollback({
          repositoryPath,
          candidateId: result.candidateId,
          health: result.health,
        });
      } else if (result.status === 'rollback-failed') {
        await coordinator.failRollback({
          repositoryPath,
          candidateId: result.candidateId,
          error: result.error ?? 'Rollback needs manual recovery.',
        });
      } else if (result.status === 'rollback-needs-recovery') {
        const recoveryError =
          result.error ?? 'Rollback stopped after replacement began; manual recovery is required.';
        if (status.candidate?.error !== recoveryError) {
          await coordinator.markRollbackNeedsRecovery({
            repositoryPath,
            candidateId: result.candidateId,
            error: recoveryError,
          });
        }
        return;
      }
      if (gate && sameRepository && gate.candidateId === result.candidateId) {
        await releaseInstallTargetGate({
          stateRoot,
          ownerId: gate.ownerId,
          repositoryPath,
          candidateId: gate.candidateId,
        });
      }
      await unlink(join(stateRoot, 'InstallJobs', `${result.candidateId}.json`)).catch(
        () => undefined
      );
      return;
    }
    const candidateId = status.applyingCandidateId;
    const jobPath = join(stateRoot, 'InstallJobs', `${candidateId}.json`);
    const job = await readFile(jobPath, 'utf8')
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (
      job?.mode === 'rollback' &&
      typeof job.nonce === 'string' &&
      typeof job.repositoryPath === 'string' &&
      resolve(job.repositoryPath).toLocaleLowerCase() ===
        resolve(repositoryPath).toLocaleLowerCase() &&
      typeof job.jobId === 'string' &&
      typeof job.previousBuild === 'object' &&
      job.previousBuild !== null &&
      host.delivery.installRoot
    ) {
      const previousBuild = job.previousBuild as Record<string, unknown>;
      const [receipt, provenance, journal] = await Promise.all([
        readFile(join(stateRoot, 'startup-receipts', `${job.nonce}.json`), 'utf8')
          .then((raw) => JSON.parse(raw) as Record<string, unknown>)
          .catch(() => null),
        readFile(join(host.delivery.installRoot, 'resources', 'build-provenance.json'), 'utf8')
          .then((raw) => JSON.parse(raw) as Record<string, unknown>)
          .catch(() => null),
        readFile(join(stateRoot, 'InstallJournals', `${job.jobId}.json`), 'utf8')
          .then((raw) => JSON.parse(raw) as Record<string, unknown>)
          .catch(() => null),
      ]);
      if (
        receipt &&
        provenance &&
        previousBuild.deliveryProtocol === 1 &&
        receipt.nonce === job.nonce &&
        receipt.commit === previousBuild.commit &&
        receipt.buildId === previousBuild.buildId &&
        receipt.version === previousBuild.version &&
        receipt.processId === process.pid &&
        provenance.deliveryProtocol === 1 &&
        provenance.commit === previousBuild.commit &&
        provenance.buildId === previousBuild.buildId &&
        provenance.version === previousBuild.version &&
        typeof receipt.readyAt === 'string'
      ) {
        const details = (journal?.details ?? {}) as Record<string, unknown>;
        await coordinator.finishRollback({
          repositoryPath,
          candidateId,
          health: {
            nonce: job.nonce,
            commit: previousBuild.commit,
            buildId: previousBuild.buildId,
            readyAt: receipt.readyAt,
            processId: receipt.processId,
            retainedCurrentInstall: details.failedRoot ?? null,
            postUpdateProfile: details.postProfileRoot ?? null,
          },
        });
        const recoveredGate = await readInstallTargetGate(stateRoot);
        if (recoveredGate?.candidateId === candidateId) {
          await releaseInstallTargetGate({
            stateRoot,
            ownerId: recoveredGate.ownerId,
            repositoryPath,
            candidateId,
          });
        }
        await unlink(jobPath).catch(() => undefined);
      }
      return;
    }
    if (
      !job ||
      typeof job.nonce !== 'string' ||
      typeof job.commit !== 'string' ||
      typeof job.buildId !== 'string' ||
      typeof job.artifactDigest !== 'string' ||
      typeof job.manifestPath !== 'string' ||
      typeof job.repositoryPath !== 'string' ||
      resolve(job.repositoryPath).toLocaleLowerCase() !==
        resolve(repositoryPath).toLocaleLowerCase()
    ) {
      return;
    }
    const [receipt, manifest, journal] = await Promise.all([
      readFile(join(stateRoot, 'startup-receipts', `${job.nonce}.json`), 'utf8')
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch(() => null),
      readFile(job.manifestPath, 'utf8')
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch(() => null),
      readFile(join(stateRoot, 'InstallJournals', `${candidateId}.json`), 'utf8')
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch(() => null),
    ]);
    if (
      !receipt ||
      !manifest ||
      receipt.nonce !== job.nonce ||
      receipt.commit !== job.commit ||
      receipt.buildId !== job.buildId ||
      receipt.processId !== process.pid ||
      manifest.commit !== job.commit ||
      manifest.buildId !== job.buildId ||
      manifest.artifactDigest !== job.artifactDigest ||
      receipt.version !== manifest.version ||
      typeof receipt.readyAt !== 'string'
    ) {
      return;
    }
    const journalDetails = journal?.details as Record<string, unknown> | undefined;
    const journalBackupRootValue = journal?.backupRoot;
    const journalBackupRoot =
      typeof journalBackupRootValue === 'string' ? journalBackupRootValue : null;
    const journalProfileBackupValue = journalDetails?.profileBackup;
    const journalProfileBackup =
      typeof journalProfileBackupValue === 'string' ? journalProfileBackupValue : null;
    const health = {
      nonce: job.nonce,
      commit: job.commit,
      buildId: job.buildId,
      artifactDigest: job.artifactDigest,
      readyAt: receipt.readyAt,
      processId: receipt.processId,
      backupRoot:
        journalBackupRoot ??
        join(resolve(host.delivery.installRoot ?? ''), `..`, `Chorus.backup-${candidateId}`),
      profileBackup: journalProfileBackup,
    };
    await coordinator.finishApply({ repositoryPath, candidateId, health });
    const recoveredGate = await readInstallTargetGate(stateRoot);
    if (
      recoveredGate &&
      recoveredGate.candidateId === candidateId &&
      resolve(recoveredGate.repositoryPath).toLocaleLowerCase() ===
        resolve(repositoryPath).toLocaleLowerCase()
    ) {
      await releaseInstallTargetGate({
        stateRoot,
        ownerId: recoveredGate.ownerId,
        repositoryPath,
        candidateId,
      });
    }
  }

  async function localRepository(projectId: string): Promise<string> {
    const [project] = await db
      .select({ path: workspaces.path, location: workspaces.location })
      .from(projects)
      .leftJoin(workspaces, eq(projects.repositoryWorkspaceId, workspaces.id))
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt), liveWorkspaces()))
      .limit(1);
    if (!project) throw new Error('The selected Chorus project is unavailable.');
    if (!project.path || project.location !== 'local') {
      throw new Error('Local installation updates require a local Git project.');
    }
    return project.path;
  }

  async function taskWorkspace(projectId: string, taskId: string) {
    const [task] = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        workspaceId: tasks.workspaceId,
        archivedAt: tasks.archivedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .limit(1);
    if (!task || task.archivedAt) return null;
    if (!task.workspaceId) return null;
    const [workspace] = await db
      .select({ path: workspaces.path, location: workspaces.location })
      .from(workspaces)
      .where(and(eq(workspaces.id, task.workspaceId), liveWorkspaces()))
      .limit(1);
    if (!workspace?.path || workspace.location !== 'local') return null;
    return { task, path: workspace.path };
  }

  async function joinTask(projectId: string, repositoryPath: string, taskId: string) {
    const workspace = await taskWorkspace(projectId, taskId);
    if (!workspace) return false;
    try {
      await access(workspace.path);
      await coordinator.join({
        repositoryPath,
        projectId,
        taskId,
        taskName: workspace.task.name,
        worktreePath: workspace.path,
      });
      return true;
    } catch (error) {
      // A pending worktree is enrolled synchronously at its first agent dispatch.
      if (error instanceof Error && error.message.includes('ENOENT')) return false;
      throw error;
    }
  }

  async function status(projectId: string): Promise<LocalUpdateStatus> {
    const repositoryPath = await localRepository(projectId);
    const pendingGate = await readInstallTargetGate(stateRoot);
    if (
      pendingGate &&
      resolve(pendingGate.repositoryPath).toLocaleLowerCase() !==
        resolve(repositoryPath).toLocaleLowerCase()
    ) {
      await completeInstallResults(pendingGate.repositoryPath);
    }
    await completeInstallResults(repositoryPath);
    const [delivery, targetGate] = await Promise.all([
      coordinator.status(repositoryPath),
      readInstallTargetGate(stateRoot),
    ]);
    return {
      ...delivery,
      targetInstallGate: targetGate
        ? {
            projectId: targetGate.projectId,
            candidateId: targetGate.candidateId,
            commit: targetGate.commit,
            phase: targetGate.phase,
            createdAt: targetGate.createdAt,
          }
        : null,
    };
  }

  async function enable(projectId: string): Promise<LocalUpdateStatus> {
    if (!host.delivery.installRoot) {
      throw new Error(
        'Local installation replacement is available only in the packaged Windows app.'
      );
    }
    const repositoryPath = await localRepository(projectId);
    await coordinator.configure({
      repositoryPath,
      projectId,
      mainRef: 'refs/heads/chorus/main',
      installTarget: host.delivery.installRoot,
    });
    const rows = await db
      .select({ id: tasks.id, archivedAt: tasks.archivedAt })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    for (const row of rows) {
      if (!row.archivedAt) await joinTask(projectId, repositoryPath, row.id);
    }
    return status(projectId);
  }

  async function prepare(
    projectId: string,
    policy: 'snapshot' | 'follow-project',
    taskIds?: string[]
  ) {
    const repositoryPath = await localRepository(projectId);
    const current = await coordinator.status(repositoryPath);
    if (!current.enabled)
      throw new Error('Enable the Chorus delivery coordinator before preparing an update.');
    return coordinator.prepare({ repositoryPath, policy, taskIds: taskIds ?? null });
  }

  async function resume(projectId: string, candidateId: string) {
    const repositoryPath = await localRepository(projectId);
    return coordinator.resumeCandidate({ repositoryPath, candidateId });
  }

  async function validate(projectId: string, candidateId: string) {
    const repositoryPath = await localRepository(projectId);
    return coordinator.validateCandidate({ repositoryPath, candidateId });
  }

  async function promote(projectId: string, candidateId: string) {
    const repositoryPath = await localRepository(projectId);
    return coordinator.promote({ repositoryPath, candidateId });
  }

  async function pushBackup(projectId: string, candidateId: string) {
    const repositoryPath = await localRepository(projectId);
    return coordinator.pushBackup({ repositoryPath, candidateId });
  }

  async function schedule(projectId: string, candidateId: string) {
    const repositoryPath = await localRepository(projectId);
    if (!host.delivery.installRoot || !host.delivery.installWorkerPath) {
      throw new Error(
        'Local Chorus installation replacement is available only in the packaged Windows app.'
      );
    }
    const pendingGate = await readInstallTargetGate(stateRoot);
    if (pendingGate) await completeInstallResults(pendingGate.repositoryPath);
    const before = await coordinator.status(repositoryPath);
    if (
      pendingGate &&
      resolve(pendingGate.repositoryPath).toLocaleLowerCase() ===
        resolve(repositoryPath).toLocaleLowerCase() &&
      pendingGate.candidateId === candidateId &&
      before.applyingCandidateId === candidateId
    ) {
      return {
        scheduled: true,
        applying: true,
        candidateId,
        alreadyScheduled: true,
        requiresManualQuit: true,
      };
    }
    const candidate = before.candidate;
    if (
      !candidate ||
      candidate.id !== candidateId ||
      !['promoted', 'scheduled'].includes(candidate.state) ||
      !candidate.validation ||
      !candidate.commit
    ) {
      throw new Error('Promote the currently validated Chorus candidate before installing it.');
    }
    const reservation = await reserveInstallTargetGate({
      stateRoot,
      ownerId: processOwnerId,
      repositoryPath,
      projectId,
      candidateId,
      commit: candidate.commit,
    });
    if (!reservation.owned) {
      return {
        scheduled: true,
        applying: before.applyingCandidateId === candidateId,
        candidateId,
        alreadyScheduled: true,
        requiresManualQuit: true,
      };
    }
    try {
      await waitForDispatchLeases();
      const sessions = await dependencies.getActiveSessionSummary();
      if (sessions.incomplete) {
        throw new Error(
          'Chorus could not confirm that all local and remote sessions are idle. Try again when session status is available.'
        );
      }
      const activeCount =
        sessions.acpSessions +
        sessions.localTuiSessions +
        sessions.remoteSessions +
        sessions.terminals;
      if (activeCount > 0) {
        throw new Error(
          `Wait for all Chorus sessions and terminals to stop before installing (${activeCount} still active).`
        );
      }
      if (candidate.state === 'promoted') {
        await coordinator.schedule({ repositoryPath, candidateId, restartPolicy: 'manual' });
      }
      await coordinator.beginApply({ repositoryPath, candidateId });
      const launchNonce = randomUUID();
      await launchInstallWorker({
        stateRoot,
        workerPath: host.delivery.installWorkerPath,
        job: {
          mode: 'install',
          candidateId,
          nonce: launchNonce,
          repositoryId: before.repositoryId,
          repositoryPath,
          mainRef: 'refs/heads/chorus/main',
          base: candidate.commit,
          stateRoot,
          installRoot: host.delivery.installRoot,
          profileRoot: host.delivery.profileRoot,
          artifactRoot: candidate.validation.artifactRoot,
          manifestPath: candidate.validation.manifestPath,
          artifactDigest: candidate.validation.artifactDigest,
          buildId: candidate.validation.buildId,
          commit: candidate.commit,
        },
      });
    } catch (error) {
      const current = await coordinator.status(repositoryPath).catch(() => null);
      if (current?.applyingCandidateId === candidateId) {
        await coordinator.failCandidate({
          repositoryPath,
          candidateId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await releaseInstallTargetGate({
        stateRoot,
        ownerId: processOwnerId,
        repositoryPath,
        candidateId,
      });
      throw error;
    }
    return { scheduled: true, applying: true, candidateId, requiresManualQuit: true };
  }

  async function cancel(projectId: string, candidateId: string) {
    const repositoryPath = await localRepository(projectId);
    await completeInstallResults(repositoryPath);
    const current = await coordinator.status(repositoryPath);
    if (current.applyingCandidateId === candidateId) {
      const gate = await readInstallTargetGate(stateRoot);
      if (
        !gate ||
        gate.candidateId !== candidateId ||
        resolve(gate.repositoryPath).toLocaleLowerCase() !==
          resolve(repositoryPath).toLocaleLowerCase()
      ) {
        throw new Error('The active install has no matching cancelable target reservation.');
      }
      const cancellation = await requestInstallWorkerCancel({ stateRoot, candidateId });
      if (!cancellation.cancelled) {
        throw new Error('The installer has begun replacing files; let it finish or recover it.');
      }
      await coordinator.cancelApply({ repositoryPath, candidateId });
      await releaseInstallTargetGate({
        stateRoot,
        ownerId: gate.ownerId,
        repositoryPath,
        candidateId,
      });
      return { cancelled: true, candidateId, beforeReplacement: true };
    }
    return coordinator.cancel({ repositoryPath, candidateId });
  }

  async function rollback(projectId: string, candidateId: string, restoreProfile: true) {
    if (restoreProfile !== true)
      throw new Error('Rollback requires explicit consent to restore the matched profile backup.');
    const repositoryPath = await localRepository(projectId);
    if (!host.delivery.installRoot || !host.delivery.installWorkerPath) {
      throw new Error('Rollback is available only in the packaged Windows Chorus app.');
    }
    const pendingGate = await readInstallTargetGate(stateRoot);
    if (pendingGate) await completeInstallResults(pendingGate.repositoryPath);
    const before = await coordinator.status(repositoryPath);
    const candidate = before.candidate;
    if (
      !candidate ||
      candidate.id !== candidateId ||
      candidate.state !== 'installed' ||
      !candidate.health?.backupRoot ||
      candidate.health.previousBuild?.deliveryProtocol !== 1
    ) {
      throw new Error('A compatible retained Chorus install is not available for rollback.');
    }
    const reservation = await reserveInstallTargetGate({
      stateRoot,
      ownerId: processOwnerId,
      repositoryPath,
      projectId,
      candidateId,
      commit: candidate.commit ?? '',
    });
    if (!reservation.owned) {
      throw new Error(
        `Chorus install target is already reserved by candidate ${reservation.gate.candidateId}.`
      );
    }
    try {
      await waitForDispatchLeases();
      const sessions = await dependencies.getActiveSessionSummary();
      if (sessions.incomplete) {
        throw new Error('Chorus could not verify that every session is idle; rollback is blocked.');
      }
      const activeCount =
        sessions.acpSessions +
        sessions.localTuiSessions +
        sessions.remoteSessions +
        sessions.terminals;
      if (activeCount > 0) {
        throw new Error(
          `Wait for all Chorus sessions and terminals to stop before rollback (${activeCount} active).`
        );
      }

      await coordinator.beginRollback({ repositoryPath, candidateId });
      const jobId = `rollback-${candidateId}-${randomUUID()}`;
      await launchInstallWorker({
        stateRoot,
        workerPath: host.delivery.installWorkerPath,
        job: {
          mode: 'rollback',
          jobId,
          candidateId,
          nonce: randomUUID(),
          repositoryId: before.repositoryId,
          repositoryPath,
          stateRoot,
          installRoot: host.delivery.installRoot,
          profileRoot: host.delivery.profileRoot,
          restoreProfile,
          backupRoot: candidate.health.backupRoot,
          profileBackup: candidate.health.profileBackup ?? null,
          previousBuild: candidate.health.previousBuild,
          commit: candidate.commit,
          buildId: candidate.health.buildId,
        },
      });
    } catch (error) {
      const current = await coordinator.status(repositoryPath).catch(() => null);
      if (current?.applyingCandidateId === candidateId) {
        await coordinator.failRollback({
          repositoryPath,
          candidateId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await releaseInstallTargetGate({
        stateRoot,
        ownerId: processOwnerId,
        repositoryPath,
        candidateId,
      });
      throw error;
    }
    return {
      rollbackScheduled: true,
      candidateId,
      previousVersion: candidate.health.previousBuild.version,
      requiresManualQuit: true,
    };
  }

  async function onTaskCreated(task: Task): Promise<void> {
    if (task.archivedAt) return;
    const repositoryPath = await localRepository(task.projectId).catch(() => null);
    if (!repositoryPath) return;
    const current = await coordinator.status(repositoryPath).catch(() => null);
    if (!current?.enabled) return;
    await joinTask(task.projectId, repositoryPath, task.id);
  }

  async function resolveTaskBase(projectId: string): Promise<string | null> {
    const repositoryPath = await localRepository(projectId).catch(() => null);
    if (!repositoryPath) return null;
    const current = await coordinator.status(repositoryPath).catch(() => null);
    return current?.enabled ? 'chorus/main' : null;
  }

  async function recordWorkStarted(projectId: string, taskId: string): Promise<() => void> {
    const release = createDispatchLease();
    let releaseShared: (() => void) | undefined;
    try {
      releaseShared = await acquireDispatchLease({ stateRoot, ownerId: processOwnerId });
      await assertInstallTargetAvailable();
      const repositoryPath = await localRepository(projectId).catch(() => null);
      if (!repositoryPath) return combineReleases(releaseShared, release);
      const current = await coordinator.status(repositoryPath).catch(() => null);
      if (!current?.enabled) return combineReleases(releaseShared, release);
      const joined = await joinTask(projectId, repositoryPath, taskId);
      if (!joined)
        throw new Error('Chorus cannot start this agent until its local Git worktree is ready.');
      await coordinator.invalidate({ repositoryPath, taskId });
      await assertInstallTargetAvailable();
      return combineReleases(releaseShared, release);
    } catch (error) {
      releaseShared?.();
      release();
      throw error;
    }
  }

  async function reconcile(): Promise<void> {
    const localProjects = await db
      .select({ id: projects.id, path: workspaces.path })
      .from(projects)
      .innerJoin(workspaces, eq(projects.repositoryWorkspaceId, workspaces.id))
      .where(and(isNull(projects.deletedAt), liveWorkspaces(), eq(workspaces.location, 'local')));
    for (const project of localProjects) {
      if (!project.path) continue;
      await completeInstallResults(project.path).catch((error) => {
        log.warn('local updates: install result reconciliation failed', {
          projectId: project.id,
          error,
        });
      });
      const current = await coordinator.status(project.path).catch(() => null);
      if (!current?.enabled) continue;
      const rows = await db
        .select({ id: tasks.id, archivedAt: tasks.archivedAt })
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)));
      for (const row of rows) {
        if (row.archivedAt) continue;
        try {
          await joinTask(project.id, project.path, row.id);
        } catch (error) {
          log.warn('local updates: task reconciliation failed', {
            projectId: project.id,
            taskId: row.id,
            error,
          });
        }
      }
    }
  }

  return {
    status,
    enable,
    prepare,
    resume,
    validate,
    promote,
    pushBackup,
    schedule,
    cancel,
    rollback,
    onTaskCreated,
    resolveTaskBase,
    recordWorkStarted,
    reconcile,
  };
}

function combineReleases(...releases: Array<() => void>): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
  };
}

export type LocalUpdateService = ReturnType<typeof createLocalUpdateService>;
