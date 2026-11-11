import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import { textVariants, type TextVariantProps } from './typography.variants';

export type SectionLabelProps = React.HTMLAttributes<HTMLElement> & {
  /** Element to render. Defaults to `span`; use `h2`/`h3` when it heads a region. */
  as?: 'span' | 'div' | 'h2' | 'h3' | 'h4' | 'p' | 'legend';
  /** Colour override; the label is passive by default. */
  tone?: TextVariantProps['tone'];
};

/**
 * SectionLabel — the group-label role (design brief 2.4): the quiet heading
 * over a group of rows ("Pinned", "Projects", "Local"), 11px in the passive
 * tone, sentence case, never uppercase. The same mark the workbench sidebar's
 * section labels use.
 *
 *   <SectionLabel as="h3">Recent</SectionLabel>
 */
export const SectionLabel = React.forwardRef<HTMLElement, SectionLabelProps>(function SectionLabel(
  { as = 'span', tone, className, ...props },
  ref
) {
  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={ref}
      data-slot="section-label"
      className={cx(textVariants({ variant: 'label', tone }), className)}
      {...props}
    />
  );
});
