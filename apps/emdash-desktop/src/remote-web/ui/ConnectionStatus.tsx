import { observer } from 'mobx-react-lite';
import { useApp } from './app-context';
import { cx } from './hooks';

const LABELS = {
  online: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
} as const;

/** A dot and a word: steady green when live, pulsing amber while the link is being restored. */
export const ConnectionStatus = observer(function ConnectionStatus({
  showOnline = true,
  className,
}: {
  /** Whether to say anything while everything is fine. */
  showOnline?: boolean;
  className?: string;
}) {
  const app = useApp();
  const status = app.linkStatus;
  const online = status === 'online';
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx('inline-flex items-center gap-1.5 text-[13px] text-fg-muted', className)}
    >
      {online && !showOnline ? null : (
        <>
          <span
            aria-hidden="true"
            className={cx(
              'size-2 rounded-full',
              online ? 'bg-success' : 'animate-pulse bg-attention'
            )}
          />
          {LABELS[status]}
        </>
      )}
    </span>
  );
});

/**
 * A slim strip across the top of a screen while the link is down. It only announces: the screen
 * beneath keeps its last known state and comes back to life on its own.
 */
export const ReconnectingBar = observer(function ReconnectingBar() {
  const app = useApp();
  if (app.linkStatus !== 'reconnecting') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-fade-in bg-attention-soft text-attention flex items-center justify-center gap-2 px-4 py-1.5 text-[12.5px] font-medium"
    >
      <span aria-hidden="true" className="bg-attention size-1.5 animate-pulse rounded-full" />
      Reconnecting to {app.hostName}…
    </div>
  );
});
