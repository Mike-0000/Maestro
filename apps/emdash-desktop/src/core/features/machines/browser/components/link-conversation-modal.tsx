import { EmptyState } from '@emdash/ui/react/components';
import { Button, Combobox, Dialog, Label, ModalLayout } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { getTasksWireClient } from '@core/features/tasks/api/browser/client';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

export interface LinkConversationModalProps {
  /** SSH connection id of the conversation's host; null for the local machine. */
  connectionId: string | null;
  conversationTitle: string;
}

export interface LinkConversationModalResult {
  projectId: string;
  taskId: string;
}

type PickerOption = { id: string; name: string };

/** Projects on the conversation's host: linking across hosts would create a dead link. */
function useHostProjects(connectionId: string | null) {
  return useQuery({
    queryKey: ['linkConversationProjects', connectionId ?? 'local'],
    queryFn: async (): Promise<PickerOption[]> => {
      if (connectionId !== null) {
        const usage = await (await getMachinesClient()).getMachineUsage(undefined);
        return (usage[connectionId] ?? []).map((project) => ({
          id: project.id,
          name: project.name,
        }));
      }
      const projectsClient = await getProjectsWireClient();
      const projectList = await projectsClient.projectList.state(undefined, 'list').snapshot();
      return projectList.data.projects
        .filter((project) => project.type === 'local')
        .map((project) => ({ id: project.id, name: project.name }));
    },
    refetchOnWindowFocus: false,
  });
}

function useProjectTasks(projectId: string | null) {
  return useQuery({
    queryKey: ['linkConversationTasks', projectId],
    queryFn: async (): Promise<PickerOption[]> => {
      const client = await getTasksWireClient();
      const list = await client.taskList.state({ projectId: projectId! }, 'list').snapshot();
      return list.data.tasks.map((task) => ({ id: task.id, name: task.name }));
    },
    enabled: projectId !== null,
    refetchOnWindowFocus: false,
  });
}

function OptionCombobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  options: PickerOption[];
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const filtered = query
    ? options.filter((option) => option.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  return (
    <Combobox.Root
      value={value}
      onValueChange={onChange}
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
      isItemEqualToValue={(a: PickerOption, b: PickerOption) => a.id === b.id}
      disabled={disabled}
    >
      <Combobox.Trigger id={id} appearance="input">
        {value ? (
          <span className="truncate">{value.name}</span>
        ) : (
          <span className="truncate text-foreground-passive">{placeholder}</span>
        )}
      </Combobox.Trigger>
      <Combobox.Content width="trigger">
        <Combobox.Input
          value={query}
          onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
          placeholder="Search…"
          showTrigger={false}
        />
        <Combobox.List>
          {filtered.map((option) => (
            <Combobox.Item key={option.id} value={option} showCheck={false}>
              <span className="truncate">{option.name}</span>
            </Combobox.Item>
          ))}
          {filtered.length === 0 && <EmptyState bare label="No matches" className="py-4" />}
        </Combobox.List>
      </Combobox.Content>
    </Combobox.Root>
  );
}

export function LinkConversationModal({
  connectionId,
  conversationTitle,
}: LinkConversationModalProps) {
  const modal = useModalController('linkConversationModal');
  const [project, setProject] = useState<PickerOption | null>(null);
  const [task, setTask] = useState<PickerOption | null>(null);
  const projects = useHostProjects(connectionId);
  const tasks = useProjectTasks(project?.id ?? null);

  const fieldId = useId();
  const projectFieldId = `${fieldId}-project`;
  const taskFieldId = `${fieldId}-task`;

  return (
    <ModalLayout
      title="Link conversation to a task"
      description={
        <>
          Choose the task <span className="text-foreground">“{conversationTitle}”</span> should
          appear under. Linking only annotates this device&apos;s registry; the conversation itself
          stays on its machine.
        </>
      }
      actions={
        <>
          <Button type="button" variant="ghost" onClick={modal.dismiss}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!project || !task}
            onClick={() => {
              if (project && task) {
                modal.complete({ projectId: project.id, taskId: task.id });
              }
            }}
          >
            Link
          </Button>
        </>
      }
    >
      <Dialog.Body className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={projectFieldId}>Project</Label>
          <OptionCombobox
            id={projectFieldId}
            options={projects.data ?? []}
            value={project}
            onChange={(next) => {
              setProject(next);
              setTask(null);
            }}
            placeholder={projects.isLoading ? 'Loading projects…' : 'Select a project…'}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={taskFieldId}>Task</Label>
          <OptionCombobox
            id={taskFieldId}
            options={tasks.data ?? []}
            value={task}
            onChange={setTask}
            placeholder={
              !project
                ? 'Select a project first'
                : tasks.isLoading
                  ? 'Loading tasks…'
                  : 'Select a task…'
            }
            disabled={!project}
          />
        </div>
      </Dialog.Body>
    </ModalLayout>
  );
}

export const linkConversationModal = defineModal<LinkConversationModalResult>()({
  id: 'linkConversationModal',
  component: LinkConversationModal,
});
