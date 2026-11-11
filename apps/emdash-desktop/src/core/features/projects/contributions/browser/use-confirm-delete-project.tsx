import { getAutomationsClient } from '@core/features/automations/api/browser/client';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { Automation } from '@core/primitives/automations/api';

async function listProjectAutomations(projectId: string): Promise<Automation[]> {
  return getAutomationsClient()
    .then((client) => client.list({ projectId }))
    .catch(() => []);
}

function deleteProjectDescription(projectLabel: string, automations: Automation[]) {
  if (automations.length === 0) {
    return `"${projectLabel}" will be removed from Maestro. Its folder and worktrees stay on disk.`;
  }

  return (
    <div className="flex flex-col gap-4">
      <p>
        {`"${projectLabel}" will be removed from Maestro. Its folder and worktrees stay on disk.`}
      </p>
      <div className="flex flex-col gap-2">
        <p className="text-foreground-muted">
          {automations.length === 1 ? 'This automation' : 'These automations'} will be detached from
          the project and will not run until attached to another project:
        </p>
        <ul className="flex max-h-32 flex-col gap-1 overflow-auto rounded-lg bg-surface-emphasis px-3 py-2 text-sm text-foreground">
          {automations.map((automation) => (
            <li key={automation.id} className="truncate">
              {automation.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function useConfirmDeleteProject() {
  const openConfirmDeleteProject = useOpenModal('confirmActionModal');

  return async ({
    projectId,
    projectLabel,
    onDeleted,
  }: {
    projectId: string;
    projectLabel: string;
    onDeleted?: () => void;
  }) => {
    const automations = await listProjectAutomations(projectId);

    const outcome = await openConfirmDeleteProject({
      title: 'Remove project',
      description: deleteProjectDescription(projectLabel, automations),
      confirmLabel: 'Remove',
    });
    if (!outcome.success) return;
    void getProjectManagerStore().deleteProject(projectId);
    onDeleted?.();
  };
}
