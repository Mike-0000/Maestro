import { controlVariants } from '@styles/recipes/control';
import { cx } from '@styles/utilities/cx';
import { FolderIcon } from 'lucide-react';
import * as React from 'react';
import * as styles from './directory-field.css';
import { fieldShellBase } from '@styles/recipes/field-shell.css';

export type DirectoryFieldSize = 'base' | 'sm';

export interface DirectoryFieldProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  path?: string;
  placeholder?: string;
  size?: DirectoryFieldSize;
  chooseLabel?: string;
}

const DirectoryField = React.forwardRef<HTMLButtonElement, DirectoryFieldProps>(
  function DirectoryField(
    {
      className,
      path,
      placeholder = 'Select a directory',
      size = 'base',
      chooseLabel = 'Choose',
      type = 'button',
      ...props
    },
    ref
  ) {
    const hasPath = path != null && path.length > 0;

    return (
      <button
        ref={ref}
        type={type}
        data-slot="directory-field"
        // The full path stays available on hover, however much of it the field shows.
        title={hasPath ? path : undefined}
        className={cx(fieldShellBase, styles.layout, size === 'sm' && styles.layoutSm, className)}
        {...props}
      >
        <FolderIcon className={styles.icon} aria-hidden />
        {hasPath ? (
          // Truncates at the start so the folder name stays visible (see valuePath).
          <span data-slot="directory-field-value" className={cx(styles.value, styles.valuePath)}>
            <bdi dir="ltr">{path}</bdi>
          </span>
        ) : (
          <span className={cx(styles.value, styles.placeholder)}>{placeholder}</span>
        )}
        <span
          className={cx(
            controlVariants({ variant: 'secondary', size: 'xs' }),
            styles.chooseAffordance
          )}
          aria-hidden
        >
          {chooseLabel}
        </span>
      </button>
    );
  }
);

export { DirectoryField };
