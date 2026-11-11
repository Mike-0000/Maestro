import { Field } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';

/**
 * A settings row whose right side holds actions rather than a single form control, so it
 * is not held to the control slot's narrow column. Same type roles as the kit `SettingsRow`:
 * the label in the field-label role, helper text muted under it.
 */
export function RemoteAccessRow({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Field.Root orientation="horizontal">
      <Field.Content>
        <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">{title}</div>
        {description != null && <Field.Description>{description}</Field.Description>}
      </Field.Content>
      {actions != null && (
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      )}
    </Field.Root>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
