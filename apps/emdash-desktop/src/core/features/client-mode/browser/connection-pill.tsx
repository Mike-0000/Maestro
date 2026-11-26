import { Button, DropdownMenu, RelativeTime } from '@emdash/ui/react/primitives';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ClientSessionStatus } from '../api/client-session-contract';
import {
  formatLatency,
  hostAddressLabel,
  hostLabel,
  linkStateLabel,
  linkTone,
  type LinkTone,
} from './client-session-format';

export type ConnectionPillProps = {
  status: ClientSessionStatus;
  /** Shortcuts are a Windows feature of the client. */
  canCreateShortcut: boolean;
  onCreateShortcut: () => void;
  onQuit: () => void;
  onForget: () => void;
};

/**
 * The link in the title bar: a state mark, the host's name and the round trip in the caption
 * role. Passive until hovered so it never competes with the view's own title-bar controls; a slow
 * link turns the latency to the warning tone, a lost one turns the mark to the error dot.
 */
export function ConnectionPill({
  status,
  canCreateShortcut,
  onCreateShortcut,
  onQuit,
  onForget,
}: ConnectionPillProps) {
  const host = hostLabel(status.host);
  const tone = linkTone(status);
  const latency = status.phase === 'connected' ? formatLatency(status.latencyMs) : null;
  const state = linkStateLabel(status);
  const address = status.host ? hostAddressLabel(status.host.url) : null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-client-connection-pill={tone}
            aria-label={`Host ${host}: ${state}. Connection menu`}
            // Title bars are window drag regions; the pill opts out so it takes clicks.
            className="h-7 max-w-56 shrink-0 gap-1.5 px-2 text-xs text-foreground-passive [-webkit-app-region:no-drag]"
          />
        }
      >
        <LinkMark tone={tone} />
        <span className="truncate">{host}</span>
        {latency ? (
          <span
            className={cn(
              'shrink-0 text-tiny tabular-nums',
              tone === 'slow' && 'text-foreground-warning'
            )}
          >
            {latency}
          </span>
        ) : null}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" width="content" className="min-w-60">
        <div className="flex max-w-72 flex-col px-2 pt-1.5 pb-2">
          <span className="truncate text-sm text-foreground">{host}</span>
          {address && address !== host ? (
            <span className="truncate text-xs text-foreground-muted">{address}</span>
          ) : null}
          <span className="mt-1 text-tiny text-foreground-passive tabular-nums">
            {status.phase === 'connected' ? (
              <>
                Connected
                {status.connectedAt !== null ? (
                  <>
                    {' '}
                    <RelativeTime value={status.connectedAt} />
                  </>
                ) : null}
                {latency ? (
                  <>
                    <span aria-hidden> · </span>
                    {latency}
                  </>
                ) : null}
              </>
            ) : (
              state
            )}
          </span>
        </div>
        <DropdownMenu.Separator />
        {canCreateShortcut ? (
          <DropdownMenu.Item onClick={onCreateShortcut}>Create a shortcut</DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item onClick={onQuit}>Disconnect and quit</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="destructive" onClick={onForget}>
          Forget this host…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/**
 * The 6px link mark, in the app's state language: a quiet dot while connected, the accent pulse
 * while the link is being made (still under reduced motion), the error dot when it is refused.
 */
function LinkMark({ tone }: { tone: LinkTone }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', {
        'bg-foreground-muted': tone === 'steady' || tone === 'slow',
        'bg-accent motion-safe:animate-pulse': tone === 'working',
        'bg-foreground-error': tone === 'down',
      })}
    />
  );
}
