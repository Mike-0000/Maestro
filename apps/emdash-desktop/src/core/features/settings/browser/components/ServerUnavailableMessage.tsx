import { TriangleAlert } from 'lucide-react';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';

/** A quiet line in place of an account action while the account server cannot be reached. */
export function ServerUnavailableMessage() {
  return (
    <p className="flex max-w-56 items-start gap-1.5 text-xs text-foreground-muted">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" aria-hidden />
      <span>{PRODUCT_NAME} server is unavailable. Try again later.</span>
    </p>
  );
}
