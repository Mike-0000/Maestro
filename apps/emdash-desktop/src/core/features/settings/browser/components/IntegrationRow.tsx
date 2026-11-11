import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { Check, Copy, ExternalLink, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { useTheme } from '@core/primitives/theme/browser';

type IntegrationStatus =
  | 'connected'
  | 'disconnected'
  | 'loading'
  | 'error'
  | 'missing'
  | 'needs_key';

interface IntegrationRowProps {
  logoSrc?: string;
  logoSrcDark?: string;
  invertInDark?: boolean;
  icon?: React.ReactNode;
  name: string;
  onNameClick?: () => void;
  status: IntegrationStatus;
  statusLabel?: string;
  accountLabel?: string;
  middle?: React.ReactNode;
  onConnect?: () => void;
  connectDisabled?: boolean;
  connectContent?: React.ReactNode;
  onDisconnect?: () => void;
  onOpen?: () => void;
  rightExtra?: React.ReactNode;
  showStatusPill?: boolean;
  installCommand?: string | null;
}

const STATUS_LABELS: Record<IntegrationStatus, string> = {
  connected: 'Connected',
  loading: 'Connecting…',
  error: 'Not connected',
  disconnected: 'Not connected',
  missing: 'Not connected',
  needs_key: 'Not connected',
};

/**
 * One tool or service in a settings card: its logo and name on the left, its state in words and
 * at most one visible action on the right. Secondary actions (open, disconnect, copy the install
 * command) are quiet icon buttons that come forward on hover or focus.
 */
const IntegrationRow: React.FC<IntegrationRowProps> = ({
  logoSrc,
  logoSrcDark,
  invertInDark,
  icon,
  name,
  onNameClick,
  status,
  statusLabel,
  accountLabel,
  middle,
  onConnect,
  connectDisabled,
  connectContent,
  onDisconnect,
  onOpen,
  rightExtra,
  showStatusPill = true,
  installCommand,
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'emdark';
  const themedLogoSrc = isDark && logoSrcDark ? logoSrcDark : logoSrc;
  const shouldInvertLogo = isDark && !!invertInDark && !logoSrcDark;
  const connected = status === 'connected';
  const showConnect = !connected && status !== 'loading' && !!onConnect;
  const showDisconnect = connected && !!onDisconnect;
  const showOpen = connected && !!onOpen;
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  const resolvedStatusLabel = statusLabel ?? STATUS_LABELS[status] ?? STATUS_LABELS.disconnected;

  const defaultMiddle =
    connected && accountLabel ? (
      <span className="truncate text-xs text-foreground-muted">{accountLabel}</span>
    ) : null;

  const isSvg = themedLogoSrc?.trimStart().startsWith('<svg');

  const avatar = (
    <span className="flex size-5 shrink-0 items-center justify-center text-foreground-muted">
      {themedLogoSrc ? (
        isSvg ? (
          <span
            className={cn(
              'inline-flex size-5 items-center justify-center [&_svg]:size-full [&_svg]:shrink-0',
              shouldInvertLogo && 'invert'
            )}
            dangerouslySetInnerHTML={{ __html: themedLogoSrc }}
          />
        ) : (
          <img
            src={themedLogoSrc}
            alt=""
            className={cn('size-5 object-contain', shouldInvertLogo && 'invert')}
          />
        )
      ) : icon ? (
        icon
      ) : null}
    </span>
  );

  const handleCopyInstall = async () => {
    if (!installCommand || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    if (copyResetRef.current !== null) {
      window.clearTimeout(copyResetRef.current);
    }
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 1600);
    } catch {
      setCopied(false);
      copyResetRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const CopyIcon = copied ? Check : Copy;
  const showInstallCopy = !!installCommand && !connected;
  const quietAction = 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100';

  return (
    <div className="group/row flex min-h-10 items-center gap-3">
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col">
        {onNameClick ? (
          <button
            type="button"
            onClick={onNameClick}
            className="flex w-fit items-center gap-1 rounded-sm text-sm text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {name}
            <ExternalLink className="size-3 text-foreground-passive" aria-hidden />
          </button>
        ) : (
          <span className="truncate text-sm text-foreground">{name}</span>
        )}
        {middle ?? defaultMiddle}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {showInstallCopy ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon
                  className={quietAction}
                  onClick={() => void handleCopyInstall()}
                  aria-label={copied ? 'Command copied' : `Copy install command for ${name}`}
                >
                  <CopyIcon className="size-3.5" aria-hidden />
                </Button>
              }
            />
            <Tooltip.Content side="top" className="max-w-60">
              <div className="text-xs text-foreground">Copy install command</div>
              <code className="block truncate font-mono text-tiny text-foreground-muted">
                {installCommand}
              </code>
            </Tooltip.Content>
          </Tooltip.Root>
        ) : null}

        {showOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon
            className={quietAction}
            onClick={onOpen}
            aria-label={`Open ${name} settings`}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </Button>
        ) : null}

        {showDisconnect ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon
            className={quietAction}
            onClick={onDisconnect}
            aria-label={`Disconnect ${name}`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        ) : null}

        {showStatusPill && !showConnect ? (
          <span
            className={cn(
              'px-1 text-xs',
              connected ? 'text-foreground-muted' : 'text-foreground-passive'
            )}
          >
            {resolvedStatusLabel}
          </span>
        ) : null}

        {rightExtra}

        {showConnect ? (
          <Button
            type="button"
            variant="text"
            size="sm"
            className="ml-1"
            onClick={onConnect}
            disabled={connectDisabled}
          >
            {connectContent ?? 'Connect'}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

export default IntegrationRow;
