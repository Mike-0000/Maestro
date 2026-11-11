import { EmptyState } from '@emdash/ui/react/components';
import { Button, SectionLabel } from '@emdash/ui/react/primitives';
import { CheckCircle2, ExternalLink, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import {
  computeCheckBucket,
  computeCheckRunsSummary,
  formatCheckDuration,
  sortCheckRunsByLatest,
  type CheckRun,
  type CheckRunBucket,
} from '@core/features/github/api/browser/checks';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  pullRequestErrorMessage,
  type PullRequest,
  type PullRequestComment,
  type PullRequestDetails,
} from '@core/services/pull-requests/api';
import { CommentsList } from './comments-list';
import { buildPullRequestConversationItems } from './pull-request-conversation';

const EMPTY_COMMENTS: PullRequestComment[] = [];

const BUCKET_WORDS: Record<CheckRunBucket, string> = {
  pass: 'Passed',
  fail: 'Failed',
  pending: 'Running',
  skipping: 'Skipped',
  cancel: 'Cancelled',
};

/**
 * A check's mark. Failures are the one thing that must jump out, so only they
 * take colour (the error tone); a pass is a quiet muted tick, a running check a
 * passive spinner (still under reduced motion), skipped / cancelled a passive dash.
 */
export function BucketIcon({ bucket }: { bucket: CheckRunBucket }) {
  const label = BUCKET_WORDS[bucket];
  switch (bucket) {
    case 'pass':
      return (
        <CheckCircle2
          role="img"
          aria-label={label}
          className="size-3.5 shrink-0 text-foreground-muted"
        />
      );
    case 'fail':
      return (
        <XCircle
          role="img"
          aria-label={label}
          className="size-3.5 shrink-0 text-foreground-error"
        />
      );
    case 'pending':
      return (
        <Loader2
          role="img"
          aria-label={label}
          className="size-3.5 shrink-0 text-foreground-passive motion-safe:animate-spin"
        />
      );
    case 'skipping':
    case 'cancel':
      return (
        <MinusCircle
          role="img"
          aria-label={label}
          className="size-3.5 shrink-0 text-foreground-passive"
        />
      );
  }
}

export function CheckRunItem({ check }: { check: CheckRun }) {
  const bucket = computeCheckBucket(check);
  const duration = formatCheckDuration(
    check.startedAt ?? undefined,
    check.completedAt ?? undefined
  );
  const subtitle = check.appName ?? check.workflowName;
  const detailsUrl = check.detailsUrl;
  return (
    <div className="group/check flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover">
      <span className="flex h-5 shrink-0 items-center">
        <BucketIcon bucket={bucket} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-sm',
              bucket === 'fail' ? 'text-foreground' : 'text-foreground-body'
            )}
          >
            {check.name}
          </span>
          {check.appLogoUrl ? (
            <img
              src={check.appLogoUrl}
              alt={check.appName ?? ''}
              className="size-3.5 shrink-0 rounded-xs opacity-60"
            />
          ) : null}
        </div>
        {(subtitle || duration) && (
          <div className="truncate text-tiny text-foreground-passive tabular-nums">
            {[subtitle, duration].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      {detailsUrl && (
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-label={`Open ${check.name} check details`}
          className="shrink-0 opacity-0 transition-opacity group-hover/check:opacity-100 focus-visible:opacity-100"
          onClick={() => void openExternal(detailsUrl)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/** "1 failing · 3 passed · 1 running": the checks at a glance, failures first. */
function ChecksSummaryLine({ checks }: { checks: CheckRun[] }) {
  const summary = computeCheckRunsSummary(checks);
  const parts = [
    summary.failed > 0 ? `${summary.failed} failing` : null,
    summary.passed > 0 ? `${summary.passed} passed` : null,
    summary.pending > 0 ? `${summary.pending} running` : null,
    summary.skipped + summary.cancelled > 0
      ? `${summary.skipped + summary.cancelled} skipped`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <span className="text-tiny text-foreground-passive tabular-nums">
      {summary.failed > 0 && <span className="text-foreground-error">{parts.shift()}</span>}
      {summary.failed > 0 && parts.length > 0 && ' · '}
      {parts.join(' · ')}
    </span>
  );
}

export function ChecksList({ checks }: { checks: CheckRun[] }) {
  const sorted = useMemo(() => sortCheckRunsByLatest(checks), [checks]);

  if (sorted.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-foreground-passive">No checks yet</p>;
  }

  return (
    <div className="flex flex-col">
      {sorted.map((check, i) => (
        <CheckRunItem key={`${check.name}-${i}`} check={check} />
      ))}
    </div>
  );
}

export const PrChecksList = observer(function PrChecksList({
  pr,
  checks,
  details,
}: {
  pr: PullRequest;
  checks: CheckRun[];
  details: PullRequestDetails | null;
}) {
  const comments = details?.comments ?? EMPTY_COMMENTS;
  const isLoading = !details || (details.refreshing && details.commentsFetchedAt === null);
  const error = details?.errors.comments
    ? new Error(pullRequestErrorMessage(details.errors.comments))
    : null;
  const conversationItems = useMemo(
    () => buildPullRequestConversationItems(pr, comments),
    [pr, comments]
  );

  if (checks.length === 0 && conversationItems.length === 0 && !isLoading && !error) {
    return (
      <EmptyState
        bare
        label="No checks or comments"
        description="They show here once GitHub reports them."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5 px-2 pt-2 pb-3">
      <section aria-labelledby="pr-checks-label">
        <div className="flex items-baseline justify-between gap-3 px-2 pb-1">
          <SectionLabel as="h3" id="pr-checks-label">
            Checks
          </SectionLabel>
          <ChecksSummaryLine checks={checks} />
        </div>
        <ChecksList checks={checks} />
      </section>
      <section aria-labelledby="pr-comments-label">
        <SectionLabel as="h3" id="pr-comments-label" className="block px-2 pb-1">
          Comments
        </SectionLabel>
        <CommentsList comments={conversationItems} isLoading={isLoading} error={error} />
      </section>
    </div>
  );
});
