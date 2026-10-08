import { Field } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';

/**
 * A settings row whose right side holds actions rather than a single form control, so it
 * is not held to the control slot's narrow column.
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
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">{title}</div>
        {description != null && <Field.Description>{description}</Field.Description>}
      </Field.Content>
      {actions != null && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </Field.Root>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
