import { observer } from 'mobx-react-lite';
import { useApp } from './app-context';
import { Spinner } from './controls';
import { cx } from './hooks';

const LABELS = {
  online: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
} as const;

/**
 * The link to the computer in words. While it is fine it is only a word (or nothing); while it
 * is being restored a small passive spinner goes with the words. No coloured lights.
 */
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
      className={cx('inline-flex min-w-0 items-center gap-1.5', className)}
    >
      {online && !showOnline ? null : (
        <>
          {online ? null : (
            <Spinner className="size-3 shrink-0 border-[1.5px] text-foreground-passive" />
          )}
          <span className="truncate">{LABELS[status]}</span>
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
      className="animate-fade-in text-detail flex min-h-8 items-center justify-center gap-2 px-4 py-1.5 text-foreground-muted"
    >
      <Spinner className="size-3 shrink-0 border-[1.5px] text-foreground-passive" />
      Reconnecting to {app.hostName}…
    </div>
  );
});
