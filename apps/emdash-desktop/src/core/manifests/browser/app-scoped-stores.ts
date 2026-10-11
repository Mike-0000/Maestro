import { canvasAppStoreContributions } from '@core/features/canvas/contributions/browser/app-stores';
import { conductorAppStoreContributions } from '@core/features/conductor/contributions/browser/app-stores';
import { machinesAppStoreContributions } from '@core/features/machines/contributions/app-stores';
import { markdownViewerAppStoreContributions } from '@core/features/markdown-viewer/contributions/browser/app-stores';
import { createProjectsAppStoreContributions } from '@core/features/projects/contributions/app-stores';
import { sourceControlAppStoreContributions } from '@core/features/source-control/contributions/browser/app-stores';
import { talkAppStoreContributions } from '@core/features/talk/contributions/browser/app-stores';
import { taskAppStoreContributions } from '@core/features/tasks/contributions/app-stores';
import { updateAppStoreContributions } from '@core/features/updates/contributions/app-stores';
import { voiceAppStoreContributions } from '@core/features/voice/contributions/browser/app-stores';
import { workbenchAppStoreContributions } from '@core/features/workbench/contributions/browser/app-stores';
import { navigationAppStoreContributions } from '@core/primitives/navigation/browser/app-stores';
import type { AppScopedStoreContribution } from '@core/primitives/scoped-stores/browser';
import { projectStoreContributions } from './project-scoped-stores';

// Order matters: Tasks and the workbench resolve the Projects store at create time, so Projects
// must come first. Navigation is registered before the feature slices so their stores can reach it
// as soon as they are created.
export const appStoreContributions: readonly AppScopedStoreContribution[] = [
  ...navigationAppStoreContributions,
  ...createProjectsAppStoreContributions(projectStoreContributions),
  ...sourceControlAppStoreContributions,
  ...taskAppStoreContributions,
  ...machinesAppStoreContributions,
  ...workbenchAppStoreContributions,
  ...canvasAppStoreContributions,
  ...markdownViewerAppStoreContributions,
  ...voiceAppStoreContributions,
  ...conductorAppStoreContributions,
  // The talk line resolves the voice and conductor stores at create time.
  ...talkAppStoreContributions,
  ...updateAppStoreContributions,
];
