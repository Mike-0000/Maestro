import type { UsageSeverity } from './usage-model';

/**
 * The text colour of a usage figure: full strength while calm, the warning colour near the
 * limit, the error colour at it. Only the figure changes colour, never a panel behind it.
 */
export const USAGE_TEXT_CLASS: Record<UsageSeverity, string> = {
  calm: 'text-foreground',
  warning: 'text-foreground-warning',
  critical: 'text-foreground-error',
};

/** The same ramp for figures that sit in the caption role (passive while calm). */
export const USAGE_CAPTION_CLASS: Record<UsageSeverity, string> = {
  calm: 'text-foreground-passive',
  warning: 'text-foreground-warning',
  critical: 'text-foreground-error',
};
