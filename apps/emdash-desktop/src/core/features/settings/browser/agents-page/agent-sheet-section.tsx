import { Tooltip } from '@emdash/ui/react/primitives';
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One section of the agent sheet: a section-title heading (with an optional "more info" mark and
 * a trailing text action), then its content. Sections stack 32px apart in the sheet body.
 */
export function AgentSheetSection({
  title,
  info,
  action,
  children,
}: {
  title: ReactNode;
  /** Extra explanation behind an info mark next to the title. */
  info?: ReactNode;
  /** One quiet action on the heading's right (a `variant="text"` button or link). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          {title}
          {info ? <InfoMark>{info}</InfoMark> : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A passive info glyph that explains a setting in a tooltip. */
export function InfoMark({
  children,
  label = 'More information',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <Tooltip.Provider delay={150}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <button
              type="button"
              className="inline-flex size-4 items-center justify-center rounded-xs font-normal text-foreground-passive transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={label}
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          }
        />
        <Tooltip.Content side="top" className="max-w-64">
          {children}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
