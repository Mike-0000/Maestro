import { SquareTerminal } from 'lucide-react';
import { getAppById, type OpenInAppId } from '@core/primitives/open-in-apps/api/open-in-apps';
import { cn } from '@core/primitives/styling/browser/cn';

interface OpenInAppIconProps {
  appId: OpenInAppId;
  /** The app's bundled icon URL (from `useOpenInApps().icons`). */
  src?: string;
  alt?: string;
  className?: string;
}

/**
 * An "Open in" app's mark. Brand icons are drawn as shipped (dark monochrome ones inverted in the
 * dark theme); generic system tools draw a glyph in the current text colour, so they follow the
 * theme instead of showing one platform's dark app tile.
 */
export function OpenInAppIcon({ appId, src, alt = '', className }: OpenInAppIconProps) {
  const app = getAppById(appId);
  if (app?.glyph === 'terminal') {
    return (
      <SquareTerminal
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cn('size-4 shrink-0', className)}
      />
    );
  }
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={cn('size-4 shrink-0 rounded-xs', app?.invertInDark && 'emdark:invert', className)}
    />
  );
}
