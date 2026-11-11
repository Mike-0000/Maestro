import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';

// Scoped class applied to every Button. The selectors read the data-variant and
// data-tone attributes set by the Button component, then set Kbd CSS variables so
// any nested Kbd (via the `kbd` prop or children) inherits the right background,
// border, and foreground for the button variant/tone.
export const kbdHost = style({
  selectors: {
    '&[data-variant="primary"][data-tone="neutral"]': {
      vars: {
        '--kbd-bg': `color-mix(in srgb, ${vars.primaryButtonForeground} 14%, transparent)`,
        '--kbd-border': 'transparent',
        '--kbd-color': `color-mix(in srgb, ${vars.primaryButtonForeground} 75%, transparent)`,
      },
    },
    '&[data-variant="primary"][data-tone="destructive"]': {
      vars: {
        '--kbd-bg': `color-mix(in srgb, ${vars.foregroundDestructive} 14%, transparent)`,
        '--kbd-border': 'transparent',
        '--kbd-color': `color-mix(in srgb, ${vars.foregroundDestructive} 75%, transparent)`,
      },
    },
    '&[data-variant="secondary"], &[data-variant="ghost"]': {
      vars: {
        '--kbd-bg': `color-mix(in srgb, ${vars.foreground} 8%, transparent)`,
        '--kbd-border': 'transparent',
        '--kbd-color': vars.foregroundPassive,
      },
    },
    '&[data-variant="text"]': {
      vars: {
        '--kbd-bg': 'transparent',
        '--kbd-border': 'transparent',
        '--kbd-color': vars.foregroundPassive,
      },
    },
  },
});
