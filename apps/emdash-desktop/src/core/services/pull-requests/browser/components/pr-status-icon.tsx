import { Tooltip } from '@emdash/ui/react/primitives';
import {
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import { type ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { type PullRequest } from '@core/services/pull-requests/api';

type PrStatusIconInput = Pick<PullRequest, 'status' | 'isDraft'>;

/**
 * A pull request's state as one glyph. The shape carries the state and the
 * tooltip / label the words; tone only ranks it (design brief 2.6): an open PR
 * reads in full strength, merged a step down, draft and closed passive. None
 * of these is an error, so none takes colour.
 */
export function StatusIcon({
  pr,
  className,
  disableTooltip = false,
}: {
  pr: PrStatusIconInput;
  disableTooltip?: boolean;
  className?: string;
}) {
  const { status, isDraft } = pr;
  const renderTooltip = (children: ReactNode, text: string) => {
    if (disableTooltip) return children;
    return (
      <Tooltip.Root>
        <Tooltip.Trigger>{children}</Tooltip.Trigger>
        <Tooltip.Content>{text}</Tooltip.Content>
      </Tooltip.Root>
    );
  };

  if (status === 'merged') {
    return renderTooltip(
      <GitMerge
        role="img"
        aria-label="Merged"
        className={cn('size-4 shrink-0 text-foreground-muted', className)}
      />,
      'Merged'
    );
  }
  if (status === 'closed') {
    return renderTooltip(
      <GitPullRequestClosed
        role="img"
        aria-label="Closed"
        className={cn('size-4 shrink-0 text-foreground-passive', className)}
      />,
      'Closed'
    );
  }
  if (status === 'open' && isDraft) {
    return renderTooltip(
      <GitPullRequestDraft
        role="img"
        aria-label="Draft"
        className={cn('size-4 shrink-0 text-foreground-passive', className)}
      />,
      'Draft'
    );
  }
  return renderTooltip(
    <GitPullRequestArrow
      role="img"
      aria-label="Open"
      className={cn('size-4 shrink-0 text-foreground', className)}
    />,
    'Open'
  );
}
