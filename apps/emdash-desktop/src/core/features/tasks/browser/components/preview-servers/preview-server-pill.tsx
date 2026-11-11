import { StateGlyph } from '@emdash/ui/react/components';
import { DropdownMenu } from '@emdash/ui/react/primitives';
import {
  ChevronDown,
  Clipboard,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCcw,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  usePreviewServers,
  useTaskComposition,
} from '@core/features/workbench/api/browser/task-composition-context';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import {
  copyTextToClipboard,
  openExternal,
} from '@core/primitives/desktop-host/browser/host-client';
import type { PreviewServer } from '@core/primitives/preview-servers/api';
import { previewServerUrl } from '@core/primitives/preview-servers/api';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  formatPreviewServerLabel,
  previewServerStatusClasses,
  previewServerStatusLabel,
} from './preview-server-format';

export const PreviewServerPill = observer(function PreviewServerPill({
  server,
}: {
  server: PreviewServer;
}) {
  const previews = usePreviewServers();
  const taskView = useTaskComposition();
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(
    taskView.projectId
  );
  const url = previewServerUrl(server);
  const hasUrl = url !== null;
  // 'not-listening' is advisory: the tunnel is open, so opening the URL is a
  // legitimate retry (a successful dial flips the status back to ready).
  const canOpen =
    (server.status.kind === 'ready' || server.status.kind === 'not-listening') && hasUrl;
  const title = hasUrl
    ? `${previewServerStatusLabel(server)} at ${url}`
    : `${previewServerStatusLabel(server)} for ${formatPreviewServerLabel(server)}`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums transition-colors outline-none',
              'hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-surface-hover',
              previewServerStatusClasses(server)
            )}
            aria-label={`Open preview ${formatPreviewServerLabel(server)}`}
            title={title}
          />
        }
      >
        {server.status.kind === 'starting' || server.status.kind === 'reconnecting' ? (
          <Loader2 className="size-3.5 shrink-0 text-foreground-passive motion-safe:animate-spin" />
        ) : server.status.kind === 'failed' ? (
          <StateGlyph state="error" size="sm" />
        ) : server.status.kind === 'not-listening' ? (
          <TriangleAlert className="size-3.5 shrink-0 text-foreground-warning" />
        ) : (
          <Globe className="size-3.5 shrink-0 text-foreground-passive" />
        )}
        <span>{formatPreviewServerLabel(server)}</span>
        <ChevronDown className="size-3 shrink-0 text-foreground-passive" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="min-w-56">
        <div className="flex flex-col gap-1 px-2 pt-1.5 pb-2">
          <span className="text-tiny text-foreground-passive">Preview</span>
          <span className="truncate text-xs text-foreground" title={url ?? undefined}>
            {url ?? 'No local URL'}
          </span>
          {server.kind === 'forwarded' ? (
            <span className="text-xs text-foreground-muted tabular-nums">
              {server.localPort === undefined
                ? `Remote ${server.remotePort}`
                : `Remote ${server.remotePort} to local ${server.localPort}`}
            </span>
          ) : null}
          {server.status.kind === 'failed' ? (
            <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <StateGlyph state="error" size="sm" />
              {server.status.message}
            </span>
          ) : null}
          {server.status.kind === 'not-listening' ? (
            <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <TriangleAlert className="size-3 shrink-0 text-foreground-warning" />
              Remote port not listening yet
            </span>
          ) : null}
          {liveActionDisabledReason ? (
            <span className="flex items-start gap-1.5 text-xs text-foreground-muted">
              <TriangleAlert className="mt-0.5 size-3 shrink-0 text-foreground-warning" />
              {liveActionDisabledReason}
            </span>
          ) : null}
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          disabled={!canOpen || Boolean(liveActionDisabledReason)}
          onClick={() => {
            if (canOpen && url) {
              taskView.paneLayout.open('browser', { initialUrl: url });
              taskView.setFocusedRegion('main');
            }
          }}
        >
          <Globe className="size-3.5" />
          Open in Maestro browser
        </DropdownMenu.Item>
        <DropdownMenu.Item
          disabled={!canOpen || Boolean(liveActionDisabledReason)}
          onClick={() => canOpen && url && void openExternal(url)}
        >
          <ExternalLink className="size-3.5" />
          Open in system browser
        </DropdownMenu.Item>
        <DropdownMenu.Item disabled={!hasUrl} onClick={() => url && void copyTextToClipboard(url)}>
          <Clipboard className="size-3.5" />
          Copy URL
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {server.kind === 'forwarded' ? (
          <DropdownMenu.Item
            disabled={Boolean(liveActionDisabledReason)}
            onClick={() => void previews.restart(server.id)}
          >
            <RefreshCcw className="size-3.5" />
            Restart forward
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item
          disabled={Boolean(liveActionDisabledReason)}
          variant="destructive"
          onClick={() => void previews.stop(server.id)}
        >
          <Square className="size-3.5" />
          Stop
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});
