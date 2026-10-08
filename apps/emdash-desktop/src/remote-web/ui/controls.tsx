import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './hooks';

// Touch-first controls on the Maestro tokens. The desktop kit (@emdash/ui) is sized for a
// pointer and ships its whole stylesheet with any one component; this app needs 44px targets
// and a small shell, so it draws the few controls it has itself.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-fg hover:bg-primary-hover active:bg-primary-hover disabled:opacity-45',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 active:bg-surface-3 disabled:text-fg-passive',
  ghost: 'text-fg-muted hover:bg-surface-2 active:bg-surface-2 disabled:text-fg-passive',
  danger:
    'bg-danger-soft text-danger border border-danger-line hover:brightness-110 disabled:opacity-45',
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
        'inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-medium',
        'transition-[background-color,opacity,transform] duration-150 active:scale-[0.98]',
        'disabled:active:scale-100',
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
        'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted',
        'transition-colors duration-150 hover:bg-surface-2 hover:text-fg active:bg-surface-3',
        'disabled:text-fg-passive disabled:hover:bg-transparent',
        className
      )}
      {...rest}
    >
      {children}
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
