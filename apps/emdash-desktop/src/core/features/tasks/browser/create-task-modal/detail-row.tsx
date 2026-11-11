import type { ReactNode } from 'react';

/**
 * One labelled row of the New conductor details under the prompt: a quiet label column in
 * the muted tone, the control beside it (design brief 2.4 key / value). Below the small
 * breakpoint the label stacks over its control.
 */
export function DetailRow({
  label,
  htmlFor,
  children,
}: {
  label: ReactNode;
  /** Associates the label with a control; omit when the control labels itself. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const labelClass = 'flex min-h-8 items-center self-start text-sm text-foreground-muted';
  return (
    <div className="grid grid-cols-1 gap-y-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-x-4">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
