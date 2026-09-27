import { createController, type Controller } from '@emdash/wire/rpc';
import { localUpdatesContract } from '../api';
import type { LocalUpdateService } from './local-update-service';

export function createLocalUpdatesWireController(service: LocalUpdateService): Controller {
  return createController(localUpdatesContract, {
    status: ({ projectId }) => run(() => service.status(projectId)),
    enable: ({ projectId }) => run(() => service.enable(projectId)),
    prepare: ({ projectId, policy, taskIds }) =>
      run(() => service.prepare(projectId, policy, taskIds)),
    resume: ({ projectId, candidateId }) => run(() => service.resume(projectId, candidateId)),
    validate: ({ projectId, candidateId }) => run(() => service.validate(projectId, candidateId)),
    promote: ({ projectId, candidateId }) => run(() => service.promote(projectId, candidateId)),
    pushBackup: ({ projectId, candidateId }) =>
      run(() => service.pushBackup(projectId, candidateId)),
    schedule: ({ projectId, candidateId }) => run(() => service.schedule(projectId, candidateId)),
    cancel: ({ projectId, candidateId }) => run(() => service.cancel(projectId, candidateId)),
    rollback: ({ projectId, candidateId, restoreProfile }) =>
      run(() => service.rollback(projectId, candidateId, restoreProfile)),
  });
}

async function run<T>(action: () => Promise<T>) {
  try {
    return { success: true as const, data: await action() };
  } catch (error) {
    return {
      success: false as const,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}
