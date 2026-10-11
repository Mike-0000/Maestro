import { toast } from '@emdash/ui/react/primitives';
import { useLayoutEffect, type ReactNode } from 'react';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { LayoutOp, OrganizeBy } from '@core/features/canvas/api/canvas-layout';
import {
  getCanvasBrowserHost,
  getCanvasStore,
} from '@core/features/canvas/contributions/browser/app-stores';
import { canvasViewDef } from '@core/features/canvas/contributions/views';
import { captureDevPerfTrace } from '@core/features/dev-perf/api/browser/capture-trace';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { toggleAppTheme } from '@core/features/settings/api/browser/theme-toggle';
import {
  getRegisteredTaskData,
  taskHostActionAvailability,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import { applyHistoryEntry } from '@core/features/workbench/browser/nav-buttons';
import { useWorkspaceLayoutContext } from '@core/features/workbench/contributions/browser/layout-provider';
import { openModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { windowScope } from '@core/manifests/browser/scope-catalog';
import { confirmRegistry } from '@core/primitives/keybindings/browser';
import {
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import {
  getNavigation,
  getNavigationHistory,
} from '@core/primitives/navigation/browser/navigation-selectors';
import { toggleSettingsView } from '@core/primitives/navigation/browser/settings-toggle';
import { openInCommandRegistry } from '@core/primitives/open-in-apps/browser/open-in-command-registry';
import { disabled, enabled, hidden, type ViewScopeImpl } from '@core/primitives/view-scopes/api';
import { scopes } from '@core/primitives/view-scopes/browser';
import { useViewScope, ViewScopeInstanceProvider } from '@core/primitives/view-scopes/react';

/** Runs a canvas layout op from a command; large changes preview first (Apply or Cancel). */
function runCanvasLayout(canvas: CanvasStore, op: LayoutOp): void {
  const result = canvas.runLayout([op], { source: 'command', allowPreview: true });
  if (!result.ok) toast(result.reason);
}

function organizeCanvas(by: OrganizeBy): void {
  const canvas = getCanvasStore();
  runCanvasLayout(canvas, { op: 'organize', scope: canvas.currentRegion(), by });
}

export function WindowScope({ children }: { readonly children: ReactNode }) {
  const { currentView } = useWorkspaceSlots();
  const taskParams = useViewParams(taskViewDef);
  const projectParams = useViewParams(projectViewDef);
  const { toggleLeftSidebar, toggleZenMode } = useWorkspaceLayoutContext();

  const currentProjectId =
    currentView === 'task'
      ? taskParams?.projectId
      : currentView === 'project'
        ? projectParams?.projectId
        : undefined;
  const currentTaskId = currentView === 'task' ? taskParams?.taskId : undefined;

  const implementation = {
    'app.settings': () => ({
      execute: () => toggleSettingsView(),
    }),
    'app.newProject': () => ({
      execute: () => {
        void openModal('addProjectModal', { strategy: 'local', mode: 'pick' });
      },
    }),
    'app.newTask': () => ({
      availability: () => {
        if (!currentProjectId) return hidden;
        return taskHostActionAvailability(currentProjectId).kind === 'enabled'
          ? enabled
          : disabled(
              projectAvailabilityUi.getLiveActionDisabledReason(currentProjectId) ??
                projectAvailabilityUi.defaultLiveActionDisabledReason
            );
      },
      execute: (input) => {
        const projectId = input?.projectId ?? currentProjectId;
        if (projectId && taskHostActionAvailability(projectId).kind === 'enabled') {
          void openModal('taskModal', { projectId });
        }
      },
    }),
    'app.giveFeedback': () => ({
      execute: () => {
        void openModal('feedbackModal', {});
      },
    }),
    'app.toggleTheme': () => ({
      execute: () => {
        void toggleAppTheme().then((result) => {
          if (result.success) return;
          toast.error('Theme not changed', { description: result.error.message });
        });
      },
    }),
    'app.navigateBack': () => ({
      availability: () =>
        getNavigationHistory().canGoBack ? enabled : disabled('No previous location'),
      execute: () => getNavigationHistory().back(applyHistoryEntry),
    }),
    'app.navigateForward': () => ({
      availability: () =>
        getNavigationHistory().canGoForward ? enabled : disabled('No next location'),
      execute: () => getNavigationHistory().forward(applyHistoryEntry),
    }),
    'app.commandPalette': () => ({
      execute: () => {
        const workspaceId =
          currentProjectId && currentTaskId
            ? (getRegisteredTaskData(currentProjectId, currentTaskId)?.workspaceId ?? undefined)
            : undefined;
        void openModal('commandPaletteModal', {
          projectId: currentProjectId,
          taskId: currentTaskId,
          workspaceId,
        });
      },
    }),
    'app.openInEditor': () => ({
      availability: () => (openInCommandRegistry.get() ? enabled : hidden),
      execute: () => openInCommandRegistry.get()?.trigger(),
    }),
    'app.confirm': () => ({
      availability: () => (confirmRegistry.current?.isEnabled() ? enabled : hidden),
      execute: () => confirmRegistry.current?.trigger(),
    }),
    'workbench.toggleLeftSidebar': () => ({
      execute: () => toggleLeftSidebar(),
    }),
    'devPerf.processPanel': () => ({
      execute: () => {
        void openModal('devProcessPanelModal');
      },
    }),
    'devPerf.captureTrace': () => ({
      execute: () => {
        toast('Recording performance trace', { description: 'Capturing 10 seconds…' });
        void captureDevPerfTrace().then((outcome) =>
          outcome.ok
            ? toast.success('Trace captured', { description: outcome.path })
            : toast.error('Trace capture failed', { description: outcome.message })
        );
      },
    }),
    'canvas.open': () => ({
      execute: () => getNavigation().navigate(canvasViewDef({})),
    }),
    'canvas.nextAttention': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        if (!getCanvasStore().focusNextAttention()) toast('No agent is waiting for you');
      },
    }),
    'canvas.fitAll': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        getCanvasStore().requestFit();
      },
    }),
    'canvas.addNote': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        getCanvasStore().addNote();
      },
    }),
    'canvas.runApp': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        const focused = canvas.focusedTileId;
        const task =
          (focused ? canvas.entryForTile(focused) : undefined) ??
          canvas.browserEntries.find((entry) => entry.tileId === focused) ??
          canvas.visibleAgentEntries[0];
        if (!task?.workspaceId) {
          toast('Focus an agent whose task has a workspace first');
          return;
        }
        void getCanvasBrowserHost().runApp({
          projectId: task.projectId,
          workspaceId: task.workspaceId,
          taskId: task.taskId,
        });
      },
    }),
    'canvas.undoLayout': () => ({
      execute: () => {
        const result = getCanvasStore().undo();
        toast(result ? `Undid: ${result.label}` : 'Nothing to undo on the canvas');
      },
    }),
    'canvas.redoLayout': () => ({
      execute: () => {
        const result = getCanvasStore().redo();
        toast(result ? `Redid: ${result.label}` : 'Nothing to redo on the canvas');
      },
    }),
    'canvas.groupSelection': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        if (!getCanvasStore().groupSelection()) toast('Select windows on the canvas first');
      },
    }),
    'canvas.newRegion': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        // Canvas Pro: a region with no parent would be a desk, so it goes on the desk in view.
        const desk = canvas.activeDeskId;
        const result = canvas.runLayout(
          [{ op: 'createRegion', members: [], ...(desk ? { parent: desk } : {}) }],
          { source: 'command' }
        );
        const created = result.ok ? result.plan.created[0] : undefined;
        if (created) canvas.setRenamingRegion(created);
      },
    }),
    'canvas.tidy': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        const scope = canvas.currentRegion();
        runCanvasLayout(canvas, { op: 'arrange', targets: null, scope, layout: 'tidy' });
      },
    }),
    'canvas.organizeByTask': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        organizeCanvas('task');
      },
    }),
    'canvas.organizeByProject': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        organizeCanvas('project');
      },
    }),
    'canvas.organizeByStatus': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        organizeCanvas('status');
      },
    }),
    'canvas.organizeByProvider': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        organizeCanvas('provider');
      },
    }),
    'canvas.stage.enter': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        if (!getCanvasStore().stageSelection()) {
          toast('Select windows or a region on the canvas first');
        }
      },
    }),
    'canvas.stage.leave': () => ({
      execute: () => {
        getCanvasStore().leaveStage();
      },
    }),
    'canvas.back': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        getCanvasStore().back();
      },
    }),
    'canvas.home': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        getCanvasStore().home();
      },
    }),
    'canvas.toggleMultiCanvas': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        getCanvasStore().toggleMultiCanvas();
      },
    }),
    'canvas.togglePro': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        const result = canvas.setMode(canvas.proMode ? 'classic' : 'pro');
        toast(
          canvas.proMode
            ? `Canvas Pro: ${result.desks} desk${result.desks === 1 ? '' : 's'}`
            : 'Classic canvas'
        );
      },
    }),
    'canvas.desk.new': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        if (!canvas.proMode) canvas.setMode('pro');
        const created = canvas.createDesk();
        if (created) canvas.setRenamingRegion(created);
      },
    }),
    'canvas.desk.next': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        if (!canvas.proMode) toast('Desks are part of Canvas Pro');
        else if (!canvas.stepDesk(1)) toast('There is no other desk');
      },
    }),
    'canvas.desk.previous': () => ({
      execute: () => {
        if (currentView !== 'canvas') getNavigation().navigate(canvasViewDef({}));
        const canvas = getCanvasStore();
        if (!canvas.proMode) toast('Desks are part of Canvas Pro');
        else if (!canvas.stepDesk(-1)) toast('There is no other desk');
      },
    }),
    'voice.toggleListening': () => ({
      execute: () => void getVoiceStore().toggle(),
    }),
    'voice.toggleMute': () => ({
      execute: () => {
        const voice = getVoiceStore();
        voice.setMuted(!voice.muted);
      },
    }),
    // Zen is workspace-chrome data; the task sidebar hides while zen is
    // active as a derived condition (no task-chrome mutation).
    'workbench.zenMode': () => ({
      execute: () => toggleZenMode(),
    }),
  } satisfies ViewScopeImpl<typeof windowScope>;

  const { instance } = useViewScope(windowScope(), implementation);

  useLayoutEffect(() => {
    if (instance) scopes.activate(instance);
  }, [instance]);

  if (!instance) return null;
  return <ViewScopeInstanceProvider instance={instance}>{children}</ViewScopeInstanceProvider>;
}
