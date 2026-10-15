import {
  isRuntimeResolveError,
  type RuntimeResolveError,
} from '@emdash/core/services/runtime-broker/api';
import { err } from '@emdash/shared';
import { log } from '@emdash/shared/logger';
import { runWithTimeout } from '@emdash/shared/scheduling';
import {
  createProvider,
  type CreateProjectProviderDependencies,
  type CreateProviderProgress,
} from '@core/features/projects/node/create-project-provider';
import type { ProjectAttachmentAdapter } from '@core/features/projects/node/project-attachment-manager';
import { fileKeyForAbsolutePath, hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import type { Project } from '@core/primitives/projects/api';
import { projectHostRef } from '@core/primitives/projects/api';
import { getProjectById } from './operations/getProjects';

const SSH_PROVIDER_TIMEOUT_MS = 60_000;
const LOCAL_PROVIDER_TIMEOUT_MS = 20_000;

export function createProjectAttachmentAdapter(
  dependencies: CreateProjectProviderDependencies
): ProjectAttachmentAdapter {
  return {
    loadProject: (projectId) => getProjectById(dependencies.db, projectId),
    statRepository: async (project) => {
      const runtime = await dependencies.runtimes.client(projectHostRef(project));
      if (!runtime.success) return err(runtime.error);
      return runtime.data.files.fs.stat(fileKeyForAbsolutePath(hostPathFromNative(project.path)));
    },
    open: (project, signal) => openProvider(dependencies, project, signal),
  };
}

export async function openProvider(
  dependencies: CreateProjectProviderDependencies,
  project: Project,
  signal: AbortSignal,
  timeoutMs = project.type === 'ssh' ? SSH_PROVIDER_TIMEOUT_MS : LOCAL_PROVIDER_TIMEOUT_MS
) {
  const progress: CreateProviderProgress = { step: 'start', timings: [] };
  let work: ReturnType<typeof createProvider> | undefined;
  try {
    return await runWithTimeout(
      (workSignal) => {
        work = createProvider(dependencies, project, { signal: workSignal, progress });
        return work;
      },
      { timeoutMs, signal }
    );
  } catch (error) {
    log.warn('ProjectAttachment: session-open did not finish', {
      projectId: project.id,
      stuckIn: progress.step,
      timings: progress.timings,
      error: error instanceof Error ? error.message : String(error),
    });
    // The work keeps running after a timeout. A provider it opens late was never handed to the
    // attachment manager, so close it here: otherwise its fetch service runs for the life of the
    // app, and every retry adds another.
    void work?.then(
      (late) => {
        if (!late.success) return;
        log.warn('ProjectAttachment: closing a provider that opened after session-open gave up', {
          projectId: project.id,
          timings: progress.timings,
        });
        void late.data.dispose().catch(() => {});
      },
      () => {}
    );
    return err(toProviderOpenError(error));
  }
}

function toProviderOpenError(
  error: unknown
): RuntimeResolveError | { type: 'error'; message: string } {
  if (isRuntimeResolveError(error)) return error;
  return {
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  };
}
