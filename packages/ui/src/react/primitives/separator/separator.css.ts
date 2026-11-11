import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';

export const separator = style({
  flexShrink: 0,
  // One subtle hairline (brief 2.2); prefer space where a rule is not needed.
  backgroundColor: vars.borderSubtle,
  selectors: {
    '&[data-orientation="horizontal"]': {
      height: '1px',
      width: '100%',
    },
    '&[data-orientation="vertical"]': {
      width: '1px',
      alignSelf: 'stretch',
    },
  },
});
