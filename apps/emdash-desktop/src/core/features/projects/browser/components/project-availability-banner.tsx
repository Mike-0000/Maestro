import { Button } from '@emdash/ui/react/primitives';
import { CloudOff, Loader2 } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import type { ProjectHostAccessState } from '@core/features/projects/api/browser/stores/project-context';
import {
  classifyProjectAvailability,
  type ProjectAvailabilityAction,
} from '@core/features/projects/browser/project-availability-presentation';
import { WORKBENCH_BOTTOM_BAR_HEIGHT_PX } from '@core/primitives/layouts/api/workbench-layout';
import { log } from '@core/primitives/logging/browser/logger';
import type { LocalProject, SshProject } from '@core/primitives/projects/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { ProjectErrorDetails } from './project-error-details';

export type ProjectAvailabilityActionHandlers = Partial<
  Record<ProjectAvailabilityAction['kind'], () => void | Promise<unknown>>
>;

type ProjectAvailabilityBannerProps = {
  project: LocalProject | SshProject;
  state: ProjectHostAccessState;
  machineName?: string;
  actionHandlers?: ProjectAvailabilityActionHandlers;
  compact?: boolean;
};

export type ProjectAvailabilityLayout = 'frame' | 'inline';

export function ProjectAvailabilityBanner({
  project,
  state,
  machineName,
  actionHandlers,
  compact = false,
}: ProjectAvailabilityBannerProps) {
  const actionDescriptionId = useId();
  const pendingActionRef = useRef<ProjectAvailabilityAction['kind'] | null>(null);
  const [pendingAction, setPendingAction] = useState<ProjectAvailabilityAction['kind'] | null>(
    null
  );
  const presentation = classifyProjectAvailability({
    host:
      project.type === 'local'
        ? { kind: 'local' }
        : { kind: 'ssh', ...(machineName ? { machineName } : {}) },
    state,
  });
  if (!presentation) return null;

  const issue = state.kind === 'degraded' ? state.issue : undefined;

  const Icon = presentation.progress ? Loader2 : CloudOff;
  const requestAction = async (action: ProjectAvailabilityAction): Promise<void> => {
    const handler = actionHandlers?.[action.kind];
    if (!handler || pendingActionRef.current) return;
    pendingActionRef.current = action.kind;
    setPendingAction(action.kind);
    try {
      await handler();
    } catch (error) {
      log.error('Failed to perform Project availability action', { action: action.kind, error });
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  return (
    <section
      role={presentation.announcement === 'assertive' ? 'alert' : 'status'}
      aria-live={presentation.announcement}
      aria-atomic="true"
      // The quiet notice: one hairline card on the emphasis step, never a tinted room. Only the
      // glyph carries the warning colour; the words carry the meaning.
      className={cn(
        'flex shrink-0 items-center gap-3 text-foreground',
        compact
          ? 'h-full w-full px-3'
          : 'rounded-lg border border-border-subtle bg-surface-emphasis px-4 py-3'
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'size-4 shrink-0',
          presentation.progress
            ? 'animate-spin text-foreground-passive motion-reduce:animate-none'
            : presentation.severity === 'error' || presentation.severity === 'warning'
              ? 'text-foreground-warning'
              : 'text-foreground-passive'
        )}
      />
      <div className="min-w-0 flex-1" title={compact ? presentation.detail : undefined}>
        <p className={compact ? 'truncate text-xs text-foreground-muted' : 'text-sm font-medium'}>
          {presentation.title}
        </p>
        <p className={compact ? 'sr-only' : 'text-xs text-foreground-muted'}>
          {presentation.detail}
        </p>
      </div>
      {presentation.actions.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-1">
          {presentation.actions.map((action) => {
            const handler = actionHandlers?.[action.kind];
            const disabled = pendingAction !== null || !handler;
            return (
              <Button
                key={action.kind}
                type="button"
                size={compact ? 'xs' : 'sm'}
                variant="text"
                aria-disabled={disabled}
                aria-describedby={disabled ? actionDescriptionId : undefined}
                onClick={() => void requestAction(action)}
              >
                {action.label}
              </Button>
            );
          })}
          {pendingAction !== null ||
          presentation.actions.some((action) => !actionHandlers?.[action.kind]) ? (
            <span id={actionDescriptionId} className="sr-only">
              {pendingAction !== null
                ? 'An availability action is already in progress.'
                : 'This action is available from another view.'}
            </span>
          ) : null}
        </div>
      ) : null}
      <ProjectErrorDetails message={issue && 'message' in issue ? issue.message : undefined} />
    </section>
  );
}

export function ProjectAvailabilityFrame({
  children,
  project,
  state,
  machineName,
  actionHandlers,
  layout = 'frame',
}: ProjectAvailabilityBannerProps & {
  children: ReactNode;
  layout?: ProjectAvailabilityLayout;
}) {
  if (layout === 'inline') {
    return (
      <div className="flex w-full flex-col gap-6">
        {state.kind !== 'ready' ? (
          <ProjectAvailabilityBanner
            project={project}
            state={state}
            machineName={machineName}
            actionHandlers={actionHandlers}
          />
        ) : null}
        {children}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      {state.kind !== 'ready' ? (
        <div
          className="surface-sunken flex shrink-0 items-center bg-surface"
          data-testid="project-connection-status"
          style={{ height: WORKBENCH_BOTTOM_BAR_HEIGHT_PX }}
        >
          <ProjectAvailabilityBanner
            compact
            project={project}
            state={state}
            machineName={machineName}
            actionHandlers={actionHandlers}
          />
        </div>
      ) : null}
    </div>
  );
}
