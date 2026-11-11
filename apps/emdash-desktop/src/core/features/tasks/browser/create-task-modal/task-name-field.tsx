import { Input } from '@emdash/ui/react/primitives';
import { useId } from 'react';
import { type TaskNameState } from '@core/features/tasks/api/browser/create-task-modal/use-task-name';
import { DetailRow } from './detail-row';

interface TaskNameFieldProps {
  state: TaskNameState;
}

/**
 * The conductor's name: a detail under the prompt, since a name is generated when it is left
 * empty (the suggestion shows as the placeholder).
 */
export function TaskNameField({ state }: TaskNameFieldProps) {
  const { taskName, placeholder, handleTaskNameChange, showSlugHint } = state;
  const inputId = useId();
  const hintId = useId();

  return (
    <DetailRow label="Name" htmlFor={inputId}>
      <div className="flex flex-col gap-1.5">
        <Input
          id={inputId}
          aria-label="Conductor name"
          aria-describedby={showSlugHint ? hintId : undefined}
          value={taskName}
          placeholder={placeholder || 'Conductor name…'}
          onChange={(e) => handleTaskNameChange(e.target.value)}
        />
        {showSlugHint && (
          <p id={hintId} className="text-xs text-foreground-muted">
            Names use letters, numbers and hyphens only.
          </p>
        )}
      </div>
    </DetailRow>
  );
}
