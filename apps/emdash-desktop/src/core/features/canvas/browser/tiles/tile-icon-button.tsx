import { Button } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';

/** A window title-bar action: the kit's quiet icon button, kept out of the board's drag. */
export function TileIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon
      aria-label={label}
      title={label}
      onClick={onClick}
      className="nodrag shrink-0"
    >
      {children}
    </Button>
  );
}
