/**
 * The face of a field-shaped popup trigger (branch, existing workspace, issue, pull request)
 * built on a bare `Combobox.Trigger`: the kit's field shell in feature Tailwind (design brief
 * 2.8). In dark a fill one step off the surface with a hairline edge; in light a near-white
 * field with the findable control edge; keyboard focus turns the edge accent and adds a 1px
 * accent ring. Height is the caller's: one-line triggers add `h-8`, two-line ones `py-1.5`.
 */
export const FIELD_TRIGGER_CLASS =
  'flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-(--em-surface-input) px-2.5 text-left text-sm text-foreground outline-none transition-colors hover:border-border-1 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring data-popup-open:border-border-1 disabled:cursor-not-allowed disabled:opacity-50 emlight:border-border-1 emlight:bg-surface-elevated emlight:hover:border-border-2';
