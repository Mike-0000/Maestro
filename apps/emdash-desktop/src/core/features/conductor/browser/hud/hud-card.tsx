import { Button } from '@emdash/ui/react/primitives';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';

/**
 * The floating layer every piece of the HUD is made of (the bar and each card raised above it):
 * the elevated surface with one subtle hairline and the theme's floating shadow, which draws
 * nothing in dark and a soft ink shadow in light, where the elevated surface and the paper under
 * it are the same lightness.
 */
export const HUD_LAYER =
  'surface-elevated pointer-events-auto border border-border-subtle bg-surface text-foreground shadow-(--em-shadow-md)';

/** How a card enters: a short fade, and nothing under reduced motion. */
const ENTER = 'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200';

export interface HudCardProps {
  /** Names the card for screen readers (`aria-label`); also makes it a landmark region. */
  label?: string;
  /** `card` (default) is the reading measure of the stack; `wide` matches the bar. */
  width?: 'card' | 'wide';
  /** Announce what appears inside (a status card the developer did not ask for). */
  role?: 'status' | 'alert';
  className?: string;
  children: ReactNode;
}

/**
 * One card above the conductor bar: the call on the line, a confirmation, a code check,
 * dictation, a reply, the history, a plan, the local update. Same surface, radius, hairline and
 * padding for all of them, so the stack reads as one family.
 */
export function HudCard({ label, width = 'card', role, className, children }: HudCardProps) {
  return (
    <section
      aria-label={label}
      role={role}
      className={cn(
        HUD_LAYER,
        ENTER,
        'w-full rounded-xl px-4 py-3',
        width === 'card' ? 'max-w-xl' : 'max-w-220',
        className
      )}
    >
      {children}
    </section>
  );
}

export interface HudCardHeaderProps {
  /** A state mark or a quiet icon before the title. */
  glyph?: ReactNode;
  title: ReactNode;
  /** Quiet facts after the title (an elapsed time, "2 more waiting"). */
  meta?: ReactNode;
  /** Actions at the right end, before the close button. */
  actions?: ReactNode;
  /** Adds the close button; its label says what closing does. */
  onClose?: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
  /** Let a long title wrap instead of shortening it (a confirmation must be read whole). */
  wrapTitle?: boolean;
}

/** The card's first line: glyph, title in the section-title role, quiet meta, actions, close. */
export function HudCardHeader({
  glyph,
  title,
  meta,
  actions,
  onClose,
  closeLabel = 'Close',
  closeDisabled,
  wrapTitle = false,
}: HudCardHeaderProps) {
  return (
    <div className={cn('flex min-h-7 gap-2', wrapTitle ? 'items-start' : 'items-center')}>
      {glyph && (
        <span
          className={cn('flex w-4 shrink-0 items-center justify-center', wrapTitle ? 'h-7' : 'h-4')}
        >
          {glyph}
        </span>
      )}
      <div
        className={cn(
          'flex min-w-0 flex-1 items-baseline gap-2',
          wrapTitle && 'min-h-7 flex-wrap items-center py-1'
        )}
      >
        <h2
          className={cn(
            'min-w-0 text-sm font-semibold text-foreground',
            wrapTitle ? 'text-pretty' : 'truncate'
          )}
        >
          {title}
        </h2>
        {meta && (
          <span className="shrink-0 text-tiny text-foreground-passive tabular-nums">{meta}</span>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-x-4">{actions}</div>}
      {onClose && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon
          aria-label={closeLabel}
          title={closeLabel}
          disabled={closeDisabled}
          onClick={onClose}
          className="-mr-1.5 shrink-0"
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** The bar's level meter: five bars that follow the microphone level, in the accent. */
export function LevelMeter({ level }: { level: number }) {
  const bars = [0.55, 0.8, 1, 0.8, 0.55];
  return (
    <span aria-hidden className="flex h-4 shrink-0 items-center gap-0.5">
      {bars.map((weight, index) => (
        <span
          key={index}
          className="w-1 rounded-full bg-accent motion-safe:transition-[height] motion-safe:duration-75"
          style={{ height: `${Math.max(3, Math.min(16, 3 + level * weight * 26))}px` }}
        />
      ))}
    </span>
  );
}
