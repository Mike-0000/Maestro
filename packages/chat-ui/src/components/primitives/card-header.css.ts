import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

// Uses content-box intentionally: the borderBottom is counted by card chrome
// measurement helpers as the header separator. The separator keeps its width
// (geometry) but draws nothing: a header never gets a rule under it.
export const cardHeader = style({
  display: 'flex',
  appearance: 'none',
  boxSizing: 'content-box',
  width: 'calc(100% - 16px)',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '6px',
  margin: 0,
  padding: '0 8px',
  background: 'transparent',
  border: 0,
  borderRadius: vars.radiusMd,
  cursor: 'pointer',
  color: vars.fgMuted,
  font: 'inherit',
  fontSize: vars.typeBodyFontSize,
  letterSpacing: 'inherit',
  textAlign: 'left',
  textTransform: 'inherit',
  transition: 'background-color 150ms, color 150ms',
  userSelect: 'none',
  selectors: {
    '&[data-body-visible]': {
      borderBottom: '1px solid transparent',
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    },
    '&:focus-visible': {
      boxShadow: `inset 0 0 0 1px ${vars.focusRing}`,
      outline: '2px solid transparent',
      outlineOffset: '-2px',
    },
    '&:hover': { background: vars.surfaceHover, color: vars.fg },
  },
});

export const cardHeaderLeft = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
});

export const cardHeaderTitle = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const cardHeaderRight = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
});

export const cardLeadingSlot = style({
  position: 'relative',
  width: '14px',
  height: '14px',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.fgPassive,
});

export const cardLeadingIcon = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'opacity 120ms ease-out',
  selectors: {
    [`${cardHeader}:hover &, ${cardHeader}:focus-visible &`]: { opacity: 0 },
  },
});

export const cardHoverChevron = style({
  position: 'absolute',
  inset: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.875rem',
  opacity: 0,
  transition: 'opacity 120ms ease-out, transform 150ms ease-out',
  selectors: {
    [`${cardHeader}:hover &, ${cardHeader}:focus-visible &`]: { opacity: 1 },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

export const cardChevronExpanded = style({
  transform: 'rotate(90deg)',
});
