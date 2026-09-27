export type DeliveryTask = {
  repositoryPath: string;
  projectId: string;
  taskId: string;
  taskName: string;
  worktreePath: string;
  mode?: 'shipping' | 'research';
};

export type DeliveryCandidate = {
  id: string;
  repositoryId: string;
  policy: 'snapshot' | 'follow-project';
  generation: number;
  base: string;
  included: Array<{ taskId: string; taskName: string; commit: string }>;
  worktreePath: string;
  state: 'preparing' | 'resuming' | 'integrated' | 'validating' | 'blocked';
  commit: string | null;
  error?: string;
};

export type DeliveryValidation = {
  integratedCommit: string;
  checks: string[];
  artifactDigest: string;
  manifestPath: string;
  buildId: string;
  artifactRoot: string;
  toolchain: { node: string; pnpm: string };
  checkedAt: string;
};

export type DeliveryStatus = {
  repositoryId: string;
  repositoryPath: string;
  enabled: boolean;
  generation: number;
  tasks: Array<{
    projectId: string;
    taskId: string;
    taskName: string;
    mode: 'shipping' | 'research';
    state: string;
    withdrawnReason: 'explicit' | 'archived' | 'deleted' | null;
    worktreePath: string;
    commit: string | null;
    revision: number;
  }>;
  candidate: null | {
    id: string;
    policy: 'snapshot' | 'follow-project';
    generation: number;
    state: string;
    base: string;
    commit: string | null;
    included: Array<{ taskId: string; taskName: string; commit: string }>;
    eligible: boolean;
    worktreePath: string;
    error: string | null;
    validation: (DeliveryValidation & { error?: string }) | null;
    githubBackup: null | {
      state: 'pending' | 'backed-up';
      remote: string;
      branch: string;
      attemptedAt?: string;
      error?: string;
    };
    health: null | {
      previousBuild?: {
        deliveryProtocol: number;
        commit: string;
        buildId: string;
        version: string;
      } | null;
      backupRoot?: string;
      profileBackup?: string | null;
      [key: string]: unknown;
    };
    rollbackHealth?: null | {
      commit?: string;
      buildId?: string;
      readyAt?: string;
      processId?: number;
      retainedCurrentInstall?: string | null;
      postUpdateProfile?: string | null;
    };
  };
  applyingCandidateId: string | null;
  installedCandidateId: string | null;
  githubBackups: Array<{
    candidateId: string;
    commit: string | null;
    state: 'pending';
    remote: string;
    branch: string;
    error: string | null;
  }>;
  lastError: string | null;
};

export function createCoordinator(options?: {
  stateRoot?: string;
  git?: (cwd: string, args: string[]) => Promise<string>;
  runValidation?: (input: {
    repositoryPath: string;
    candidate: DeliveryCandidate;
    stateRoot: string;
    git: (cwd: string, args: string[]) => Promise<string>;
  }) => Promise<DeliveryValidation>;
}): {
  configure(input: {
    repositoryPath: string;
    projectId: string;
    mainRef?: string;
    installTarget?: string | null;
  }): Promise<unknown>;
  status(repositoryPath: string): Promise<DeliveryStatus>;
  identify(worktreePath: string): Promise<{
    repositoryId: string;
    repositoryPath: string;
    projectId: string;
    taskId: string;
    taskName: string;
    mode: 'shipping' | 'research';
    state: string;
    base: string;
    revision: number;
    commit: string | null;
  }>;
  join(input: DeliveryTask): Promise<unknown>;
  invalidate(input: { repositoryPath: string; taskId: string; reason?: string }): Promise<unknown>;
  submit(input: {
    repositoryPath: string;
    taskId: string;
    commit: string;
    base: string;
    summary: string;
    dependencies?: Array<{ taskId: string; commit: string }>;
    checks?: string[];
  }): Promise<unknown>;
  noChange(input: {
    repositoryPath: string;
    taskId: string;
    commit: string;
    base: string;
    summary?: string;
  }): Promise<unknown>;
  withdraw(input: { repositoryPath: string; taskId: string }): Promise<unknown>;
  retire(input: {
    repositoryPath: string;
    taskId: string;
    reason: 'archived' | 'deleted';
  }): Promise<{ withdrawn: boolean; generation: number }>;
  prepare(input: {
    repositoryPath: string;
    policy?: 'snapshot' | 'follow-project';
    taskIds?: string[] | null;
  }): Promise<DeliveryCandidate>;
  resumeCandidate(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  validateCandidate(input: {
    repositoryPath: string;
    candidateId: string;
  }): Promise<{ validated: boolean; state: string; error?: string }>;
  promote(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  pushBackup(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  schedule(input: {
    repositoryPath: string;
    candidateId: string;
    restartPolicy: 'manual';
  }): Promise<unknown>;
  beginApply(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  finishApply(input: {
    repositoryPath: string;
    candidateId: string;
    health: Record<string, unknown>;
  }): Promise<unknown>;
  failCandidate(input: {
    repositoryPath: string;
    candidateId: string;
    error: string;
  }): Promise<unknown>;
  markCandidateNeedsRecovery(input: {
    repositoryPath: string;
    candidateId: string;
    error: string;
  }): Promise<unknown>;
  cancelApply(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  beginRollback(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  finishRollback(input: {
    repositoryPath: string;
    candidateId: string;
    health: Record<string, unknown>;
  }): Promise<unknown>;
  failRollback(input: {
    repositoryPath: string;
    candidateId: string;
    error: string;
  }): Promise<unknown>;
  markRollbackNeedsRecovery(input: {
    repositoryPath: string;
    candidateId: string;
    error: string;
  }): Promise<unknown>;
  cancel(input: { repositoryPath: string; candidateId: string }): Promise<unknown>;
  repositoryIdentity(
    worktreePath: string
  ): Promise<{ repositoryPath: string; gitCommonDir: string; repositoryId: string }>;
};
export function defaultStateRoot(): string;
