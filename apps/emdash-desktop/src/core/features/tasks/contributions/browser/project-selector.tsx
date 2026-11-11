import { Combobox } from '@emdash/ui/react/primitives';
import { ChevronDown, FolderClosed, FolderInput } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useState } from 'react';
import {
  asAvailableProject,
  getProjectManagerStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { FIELD_TRIGGER_CLASS } from '@core/features/tasks/browser/task-config/field-trigger';
import { cn } from '@core/primitives/styling/browser/cn';

interface ProjectOption {
  value: string;
  label: string;
  isSsh: boolean;
}

function ProjectIcon({ isSsh }: { isSsh: boolean }) {
  const Icon = isSsh ? FolderInput : FolderClosed;
  return <Icon className="size-3.5 shrink-0 text-foreground-passive" />;
}

interface ProjectSelectorProps {
  value: string | undefined;
  onChange: (projectId: string) => void;
  trigger?: React.ReactNode;
}

export const ProjectSelector = observer(function ProjectSelector({
  value,
  onChange,
  trigger,
}: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);

  const options: ProjectOption[] = Array.from(getProjectManagerStore().projects.entries()).flatMap(
    ([id, store]) => {
      const context = asAvailableProject(store);
      return context
        ? [
            {
              value: id,
              label: context.project.name,
              isSsh: context.project.type === 'ssh',
            },
          ]
        : [];
    }
  );

  const selectedOption = options.find((o) => o.value === value) ?? null;

  function handleValueChange(item: ProjectOption | null) {
    if (!item) return;
    onChange(item.value);
    setOpen(false);
  }

  return (
    <Combobox.Root
      items={[{ value: 'options', items: options }]}
      value={selectedOption}
      onValueChange={handleValueChange}
      open={open}
      onOpenChange={setOpen}
      isItemEqualToValue={(a: ProjectOption, b: ProjectOption) => a.value === b.value}
      filter={(item: ProjectOption, query) =>
        item.label.toLowerCase().includes(query.toLowerCase())
      }
      autoHighlight
    >
      {trigger ?? (
        <Combobox.Trigger className={cn(FIELD_TRIGGER_CLASS, 'h-8')}>
          {selectedOption && <ProjectIcon isSsh={selectedOption.isSsh} />}
          <span className="min-w-0 flex-1 truncate">
            <Combobox.Value placeholder="Select a project" />
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
        </Combobox.Trigger>
      )}
      <Combobox.Content width="content-at-least-trigger">
        <Combobox.Input showTrigger={false} placeholder="Search projects…" />
        <Combobox.List>
          {(group: { value: string; items: ProjectOption[] }) => (
            <Combobox.Group key={group.value} items={group.items}>
              <Combobox.Collection>
                {(item: ProjectOption) => (
                  <Combobox.Item key={item.value} value={item}>
                    <ProjectIcon isSsh={item.isSsh} />
                    {item.label}
                  </Combobox.Item>
                )}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox.Root>
  );
});
