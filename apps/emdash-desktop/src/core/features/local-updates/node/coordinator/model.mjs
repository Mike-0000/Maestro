export const DELIVERY_SCHEMA_VERSION = 1;

export function createProjectState({
  repositoryId,
  repositoryPath,
  mainRef = 'refs/heads/chorus/main',
  installTarget = null,
}) {
  return {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    repositoryId,
    repositoryPath,
    mainRef,
    installTarget,
    generation: 0,
    enabled: false,
    tasks: {},
    candidates: {},
    activeCandidateId: null,
    applyingCandidateId: null,
    installedCandidateId: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

export function applyEvent(previous, event) {
  const next = structuredClone(previous);
  next.updatedAt = event.at ?? new Date().toISOString();

  switch (event.type) {
    case 'project-enabled':
      next.repositoryPath = event.repositoryPath ?? next.repositoryPath;
      next.mainRef = event.mainRef ?? next.mainRef;
      next.installTarget = event.installTarget ?? next.installTarget;
      next.enabled = true;
      break;
    case 'project-disabled':
      next.enabled = false;
      break;
    case 'task-joined': {
      const existing = next.tasks[event.taskId];
      if (existing) return previous;
      next.tasks[event.taskId] = {
        projectId: event.projectId,
        taskId: event.taskId,
        taskName: event.taskName,
        worktreePath: event.worktreePath,
        baseCommit: event.baseCommit,
        mode: event.mode,
        state: 'working',
        revision: 0,
        ready: null,
        history: [],
        joinedAt: event.at,
        updatedAt: event.at,
      };
      next.generation += 1;
      break;
    }
    case 'task-work-started': {
      const task = requireTask(next, event.taskId);
      if (task.state === 'withdrawn') throw new Error('Withdrawn work must rejoin explicitly.');
      task.state = 'working';
      task.ready = null;
      task.revision += 1;
      task.updatedAt = event.at;
      next.generation += 1;
      break;
    }
    case 'task-submitted': {
      const task = requireTask(next, event.taskId);
      task.state = 'submitted';
      task.ready = {
        commit: event.commit,
        base: event.base,
        summary: event.summary,
        changedPaths: event.changedPaths,
        pin: event.pin,
        dependencies: event.dependencies,
        checks: event.checks,
        revision: task.revision,
        submittedAt: event.at,
      };
      task.history.push(task.ready);
      task.updatedAt = event.at;
      next.generation += 1;
      break;
    }
    case 'task-no-change': {
      const task = requireTask(next, event.taskId);
      task.state = 'no-change';
      task.ready = {
        commit: event.commit,
        base: event.base,
        summary: event.summary,
        changedPaths: [],
        dependencies: [],
        checks: event.checks,
        revision: task.revision,
        submittedAt: event.at,
      };
      task.history.push(task.ready);
      task.updatedAt = event.at;
      next.generation += 1;
      break;
    }
    case 'task-withdrawn': {
      const task = requireTask(next, event.taskId);
      task.state = 'withdrawn';
      task.ready = null;
      // Lifecycle withdrawals (archived or deleted tasks) can be reversed by restoring the task;
      // an explicit withdrawal stays until the task rejoins explicitly.
      task.withdrawnReason = event.reason ?? 'explicit';
      task.updatedAt = event.at;
      next.generation += 1;
      break;
    }
    case 'task-rejoined': {
      const task = requireTask(next, event.taskId);
      if (task.state !== 'withdrawn') throw new Error('Only withdrawn work can rejoin.');
      task.state = 'working';
      task.ready = null;
      task.withdrawnReason = null;
      task.revision += 1;
      task.updatedAt = event.at;
      next.generation += 1;
      break;
    }
    case 'candidate-prepared': {
      const candidate = event.candidate;
      if (next.candidates[candidate.id]) return previous;
      next.candidates[candidate.id] = candidate;
      next.activeCandidateId = candidate.id;
      next.lastError = null;
      break;
    }
    case 'candidate-validation': {
      const candidate = requireCandidate(next, event.candidateId);
      candidate.state = event.success ? 'validated' : 'blocked';
      candidate.validation = event.validation;
      candidate.updatedAt = event.at;
      if (!event.success) next.lastError = event.validation?.error ?? 'Validation failed.';
      break;
    }
    case 'candidate-validation-started': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'integrated')
        throw new Error('Only an integrated candidate can be validated.');
      candidate.state = 'validating';
      candidate.updatedAt = event.at;
      break;
    }
    case 'candidate-promoted': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'validated')
        throw new Error('Only a validated candidate can be promoted.');
      candidate.state = 'promoted';
      candidate.promotedAt = event.at;
      candidate.githubBackup = { state: 'pending', remote: 'origin', branch: 'main' };
      candidate.updatedAt = event.at;
      for (const included of candidate.included) {
        const task = next.tasks[included.taskId];
        if (task?.ready?.commit === included.commit && task.state === 'submitted') {
          task.state = 'integrated';
          task.updatedAt = event.at;
        }
      }
      break;
    }
    case 'candidate-github-backup': {
      const candidate = requireCandidate(next, event.candidateId);
      if (
        candidate.state !== 'promoted' &&
        candidate.state !== 'scheduled' &&
        candidate.state !== 'applying' &&
        candidate.state !== 'installed'
      ) {
        throw new Error('Only a promoted candidate can update its GitHub backup status.');
      }
      candidate.githubBackup = {
        state: event.success ? 'backed-up' : 'pending',
        remote: event.remote,
        branch: event.branch,
        attemptedAt: event.at,
        ...(event.error && { error: event.error }),
      };
      candidate.updatedAt = event.at;
      break;
    }
    case 'candidate-integrated': {
      const candidate = requireCandidate(next, event.candidateId);
      if (!['preparing', 'resuming'].includes(candidate.state)) {
        throw new Error('Only an active integration candidate can be completed.');
      }
      candidate.commit = event.commit;
      candidate.state = 'integrated';
      candidate.updatedAt = event.at;
      break;
    }
    case 'candidate-resuming': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'blocked')
        throw new Error('Only a blocked conflict candidate can resume integration.');
      candidate.state = 'resuming';
      candidate.updatedAt = event.at;
      break;
    }
    case 'candidate-blocked': {
      const candidate = requireCandidate(next, event.candidateId);
      candidate.state = 'blocked';
      candidate.error = event.error;
      candidate.updatedAt = event.at;
      next.lastError = event.error;
      break;
    }
    case 'candidate-scheduled': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'promoted')
        throw new Error('Only a promoted, validated candidate can be scheduled.');
      candidate.state = 'scheduled';
      candidate.restartPolicy = event.restartPolicy;
      candidate.updatedAt = event.at;
      break;
    }
    case 'candidate-cancelled': {
      const candidate = requireCandidate(next, event.candidateId);
      if (['applying', 'installed'].includes(candidate.state)) {
        throw new Error('An applying or installed candidate needs its dedicated recovery action.');
      }
      candidate.state = 'cancelled';
      candidate.updatedAt = event.at;
      if (next.activeCandidateId === candidate.id) next.activeCandidateId = null;
      break;
    }
    case 'candidate-cancelled-before-apply': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'applying' || next.applyingCandidateId !== candidate.id) {
        throw new Error('Only the active, not-yet-replacing candidate can be cancelled.');
      }
      candidate.state = 'cancelled';
      candidate.updatedAt = event.at;
      next.applyingCandidateId = null;
      if (next.activeCandidateId === candidate.id) next.activeCandidateId = null;
      break;
    }
    case 'candidate-applying': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'scheduled') {
        throw new Error('Only a promoted, scheduled candidate can be applied.');
      }
      if (!isCandidateEligible(next, candidate)) {
        throw new Error('Project membership changed; prepare a fresh candidate before applying.');
      }
      candidate.state = 'applying';
      candidate.updatedAt = event.at;
      next.applyingCandidateId = candidate.id;
      break;
    }
    case 'candidate-installed': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'applying') throw new Error('Candidate was not applying.');
      candidate.state = 'installed';
      candidate.health = event.health;
      candidate.updatedAt = event.at;
      next.installedCandidateId = candidate.id;
      next.applyingCandidateId = null;
      break;
    }
    case 'candidate-rollback-started': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'installed' || next.installedCandidateId !== candidate.id) {
        throw new Error('Only the currently installed candidate can be rolled back.');
      }
      candidate.state = 'rolling-back';
      candidate.error = null;
      candidate.updatedAt = event.at;
      next.applyingCandidateId = candidate.id;
      break;
    }
    case 'candidate-rolled-back': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'rolling-back' || next.applyingCandidateId !== candidate.id) {
        throw new Error('The candidate is not in the rollback phase.');
      }
      candidate.state = 'rolled-back';
      candidate.rollbackHealth = event.health;
      candidate.updatedAt = event.at;
      next.installedCandidateId = null;
      next.applyingCandidateId = null;
      break;
    }
    case 'candidate-rollback-failed': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'rolling-back' || next.applyingCandidateId !== candidate.id) {
        throw new Error('The candidate is not in the rollback phase.');
      }
      candidate.state = 'installed';
      candidate.error = event.error;
      candidate.updatedAt = event.at;
      next.applyingCandidateId = null;
      next.lastError = event.error;
      break;
    }
    case 'candidate-rollback-recovery-needed': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'rolling-back' || next.applyingCandidateId !== candidate.id) {
        throw new Error('The candidate is not in the rollback phase.');
      }
      candidate.error = event.error;
      candidate.updatedAt = event.at;
      next.lastError = event.error;
      break;
    }
    case 'candidate-failed': {
      const candidate = requireCandidate(next, event.candidateId);
      candidate.state = 'failed';
      candidate.error = event.error;
      candidate.updatedAt = event.at;
      if (next.applyingCandidateId === candidate.id) next.applyingCandidateId = null;
      next.lastError = event.error;
      break;
    }
    case 'candidate-install-recovery-needed': {
      const candidate = requireCandidate(next, event.candidateId);
      if (candidate.state !== 'applying' || next.applyingCandidateId !== candidate.id) {
        throw new Error('The candidate is not in the install phase.');
      }
      candidate.state = 'recovery-required';
      candidate.error = event.error;
      candidate.updatedAt = event.at;
      next.lastError = event.error;
      break;
    }
    default:
      throw new Error(`Unknown delivery event: ${event.type}`);
  }

  return next;
}

export function isCandidateEligible(state, candidate) {
  if (candidate.policy === 'snapshot') return true;
  if (candidate.policy !== 'follow-project' || candidate.generation !== state.generation)
    return false;
  return Object.values(state.tasks).every(
    (task) =>
      task.state === 'withdrawn' ||
      task.state === 'excluded' ||
      task.state === 'integrated' ||
      task.state === 'submitted' ||
      task.state === 'no-change'
  );
}

export function requireTask(state, taskId) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Task ${taskId} is not enrolled in this repository.`);
  return task;
}

export function requireCandidate(state, candidateId) {
  const candidate = state.candidates[candidateId];
  if (!candidate) throw new Error(`Unknown delivery candidate ${candidateId}.`);
  return candidate;
}
