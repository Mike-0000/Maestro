import { Field } from '@react/primitives/field';
import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import * as styles from './settings.css';

export interface SettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  htmlFor?: string;
  controlClassName?: string;
  className?: string;
  /**
   * `inline` (default): label and helper on the left, the control on the right,
   * vertically centred. `stacked`: the control sits under the label at full
   * width — for long values (URLs, paths, keys, environment values).
   */
  layout?: 'inline' | 'stacked';
}

/**
 * SettingsRow — label and supporting text paired with a control (design brief
 * 2.8). Label in the field-label role (13px, full strength), helper text 12px
 * muted under it. Controls come from the kit: switches as-is, selects and
 * comboboxes `w-56`, short text inputs `w-64`; use `layout="stacked"` for long
 * values.
 *
 * Use this for custom or externally controlled settings. Form-backed settings
 * can use the horizontal fields from `@emdash/ui/react/form` directly.
 */
export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  controlClassName,
  className,
  layout = 'inline',
}: SettingsRowProps) {
  if (layout === 'stacked') {
    return (
      <Field.Root
        orientation="vertical"
        data-layout="stacked"
        className={cx(styles.rowStacked, className)}
      >
        <Field.Content>
          <Field.Label htmlFor={htmlFor}>{label}</Field.Label>
          {description != null && <Field.Description>{description}</Field.Description>}
        </Field.Content>
        <div className={cx(styles.rowStackedControl, controlClassName)}>{control}</div>
      </Field.Root>
    );
  }

  return (
    <Field.Root orientation="horizontal" className={cx(styles.row, className)}>
      <Field.Content>
        <Field.Label htmlFor={htmlFor}>{label}</Field.Label>
        {description != null && <Field.Description>{description}</Field.Description>}
      </Field.Content>
      <Field.ControlSlot className={controlClassName}>{control}</Field.ControlSlot>
    </Field.Root>
  );
}
