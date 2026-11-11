import { Button, Popover, RelativeTime, Tooltip } from '@emdash/ui/react/primitives';
import { ExternalLink } from 'lucide-react';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { cn } from '@core/primitives/styling/browser/cn';
import { getPrNumber, type PullRequest } from '@core/services/pull-requests/api';
import { PrMergeLine } from './pr-merge-line';
import { PrNumberBadge } from './pr-number-badge';
import { StatusIcon } from './pr-status-icon';
import { PrUrlCopyButton } from './pr-url-copy-button';

interface PrBadgeProps {
  variant?: 'default' | 'compact';
  pr: PullRequest;
  className?: string;
  hoverDelay?: number;
}

export function PrBadge({ variant = 'default', pr, className, hoverDelay }: PrBadgeProps) {
  const renderBadge = () => {
    switch (variant) {
      case 'default':
        return (
          <div
            className={cn(
              'flex h-5 max-w-52 items-center gap-1.5 rounded-sm bg-surface-emphasis px-1.5 leading-none',
              className
            )}
          >
            <StatusIcon className="size-3" pr={pr} disableTooltip />
            <span className="shrink-0 text-xs leading-none text-foreground-passive tabular-nums">
              #{getPrNumber(pr) ?? 0}
            </span>
            <span className="truncate text-xs leading-none text-foreground-muted">{pr.title}</span>
          </div>
        );
      case 'compact':
        return (
          <div className={cn('flex h-5 items-center justify-center px-1 leading-none', className)}>
            <StatusIcon className="size-3" pr={pr} disableTooltip />
          </div>
        );
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger className="flex items-center leading-none" openOnHover delay={hoverDelay}>
        {renderBadge()}
      </Popover.Trigger>
      <Popover.Content className="w-auto max-w-sm min-w-72">
        {/* Hover card: state + title, then who wants to merge what; the two
            actions (open, copy) are quiet icon buttons at the end of the title. */}
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusIcon pr={pr} className="size-3.5" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {pr.title}
            </span>
            <span className="-mr-1 flex shrink-0 items-center">
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      icon
                      aria-label="Open PR on GitHub"
                      onClick={() => openExternal(pr.url)}
                    >
                      <ExternalLink className="size-3.5" />
                    </Button>
                  }
                />
                <Tooltip.Content>Open PR on GitHub</Tooltip.Content>
              </Tooltip.Root>
              <PrUrlCopyButton url={pr.url} />
            </span>
          </div>
          <PrMergeLine pr={pr} />
          <span className="text-tiny text-foreground-passive tabular-nums">
            <PrNumberBadge
              number={getPrNumber(pr) ?? 0}
              className="text-tiny text-foreground-passive"
            />
            {' · opened '}
            <RelativeTime value={pr.createdAt} compact />
          </span>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
