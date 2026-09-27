import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const localUpdatesDomain = 'localUpdates' as const;

export type LocalUpdateResult<T> =
  | { success: true; data: T }
  | { success: false; error: { message: string } };

export type LocalUpdateStatus = {
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
    validation: null | {
      integratedCommit: string;
      checks: string[];
      artifactDigest: string;
      manifestPath: string;
      buildId: string;
      artifactRoot: string;
      toolchain: { node: string; pnpm: string };
      checkedAt: string;
    };
    githubBackup: null | {
      state: 'pending' | 'backed-up';
      remote: string;
      branch: string;
      attemptedAt?: string;
      error?: string;
    };
    health: null | {
      nonce?: string;
      commit?: string;
      buildId?: string;
      artifactDigest?: string;
      readyAt?: string;
      processId?: number;
      backupRoot?: string;
      profileBackup?: string | null;
      previousBuild?: {
        deliveryProtocol: number;
        commit: string;
        buildId: string;
        version: string;
      } | null;
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
  targetInstallGate: null | {
    projectId: string;
    candidateId: string;
    commit: string;
    phase: string;
    createdAt: string;
  };
};

export const localUpdatesContract = defineContract({
  status: procedure({
    input: z.object({ projectId: z.string().min(1) }),
    output: z.custom<LocalUpdateResult<LocalUpdateStatus>>(),
  }),
  enable: procedure({
    input: z.object({ projectId: z.string().min(1) }),
    output: z.custom<LocalUpdateResult<LocalUpdateStatus>>(),
  }),
  prepare: procedure({
    input: z.object({
      projectId: z.string().min(1),
      policy: z.enum(['snapshot', 'follow-project']),
      taskIds: z.array(z.string().min(1)).optional(),
    }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  resume: procedure({
    input: z.object({ projectId: z.string().min(1), candidateId: z.string().uuid() }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  validate: procedure({
    input: z.object({ projectId: z.string().min(1), candidateId: z.string().uuid() }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  promote: procedure({
    input: z.object({ projectId: z.string().min(1), candidateId: z.string().uuid() }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  pushBackup: procedure({
    input: z.object({ projectId: z.string().min(1), candidateId: z.string().uuid() }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  schedule: procedure({
    input: z.object({
      projectId: z.string().min(1),
      candidateId: z.string().uuid(),
      restartPolicy: z.literal('manual'),
    }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  cancel: procedure({
    input: z.object({ projectId: z.string().min(1), candidateId: z.string().uuid() }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
  rollback: procedure({
    input: z.object({
      projectId: z.string().min(1),
      candidateId: z.string().uuid(),
      restoreProfile: z.literal(true),
    }),
    output: z.custom<LocalUpdateResult<unknown>>(),
  }),
});
