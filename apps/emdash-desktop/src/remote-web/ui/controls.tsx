import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './hooks';

// Touch-first controls on the Maestro tokens. The desktop kit (@emdash/ui) is sized for a
// pointer and ships its whole stylesheet with any one component; this app needs 44px targets
// and a small shell, so it draws the few controls it has itself, in the kit's language: one
// primary per view, quiet ghost and text actions for the rest, the accent focus ring.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover disabled:opacity-45',
  // A quiet fill, for the rare second solid action.
  secondary:
    'bg-surface-emphasis text-foreground hover:bg-surface-selected active:bg-surface-selected disabled:text-foreground-passive',
  ghost:
    'text-foreground-muted hover:bg-surface-hover hover:text-foreground active:bg-surface-hover disabled:text-foreground-passive',
  // The desktop's destructive button: a quiet red room with red ink, only inside its confirm.
  danger:
    'bg-destructive text-foreground-destructive hover:bg-destructive-hover active:bg-destructive-hover disabled:opacity-45',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
  block?: boolean;
};

export function Button({
  variant = 'secondary',
  busy = false,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-body font-medium',
        'transition-colors duration-150',
        block && 'w-full',
        BUTTON_VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** A quiet action in words: muted and underlined, full strength on hover, 44px tall to tap. */
export function TextAction({
  className,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cx('text-action text-body', className)} {...rest}>
      {children}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Accessible name; icon buttons have no visible text. */
  label: string;
  children: ReactNode;
};

export function IconButton({
  label,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-foreground-muted',
        'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground active:bg-surface-hover',
        'disabled:text-foreground-passive disabled:hover:bg-transparent',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

type SwitchProps = {
  checked: boolean;
  onChange(checked: boolean): void;
  /** Id of the element that names this switch. */
  labelledBy: string;
  describedBy?: string;
};

/** An on/off setting that takes effect at once. */
export function Switch({ checked, onChange, labelledBy, describedBy }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      // The track is small; the padding makes the touch target 44px tall.
      className="-my-2 -mr-1 flex h-11 shrink-0 items-center rounded-full px-1"
    >
      <span
        className={cx(
          'flex h-7 w-12 items-center rounded-full border p-0.5 transition-colors duration-150',
          checked ? 'border-transparent bg-primary' : 'border-border-control bg-surface-emphasis'
        )}
      >
        <span
          className={cx(
            'size-[1.375rem] rounded-full transition-transform duration-150',
            checked ? 'translate-x-5 bg-primary-foreground' : 'bg-foreground-muted'
          )}
        />
      </span>
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent',
        className
      )}
    />
  );
}
