import type { ConnectionState } from '@core/primitives/ssh/api';
import { cn } from '@core/primitives/styling/browser/cn';

const LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  error: 'Connection error',
};

/**
 * A 6px connection mark beside a remote project or task (brief 2.6): connected reads as a quiet
 * muted dot, connecting as the accent pulse (still under reduced motion), a lost or failed
 * connection as the error dot. The words are its accessible name and tooltip.
 */
export function ConnectionStatusDot({ state }: { state: ConnectionState | null }) {
  if (!state) return null;
  const label = `SSH: ${LABELS[state]}`;
  return (
    <span
      role="img"
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', {
        'bg-foreground-muted': state === 'connected',
        'bg-accent motion-safe:animate-pulse': state === 'connecting' || state === 'reconnecting',
        'bg-foreground-error': state === 'disconnected' || state === 'error',
      })}
      aria-label={label}
      title={label}
    />
  );
}
