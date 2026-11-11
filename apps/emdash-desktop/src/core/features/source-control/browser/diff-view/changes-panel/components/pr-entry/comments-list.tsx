import { Markdown } from '@emdash/ui/react/components';
import { Button, RelativeTime } from '@emdash/ui/react/primitives';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  sortPullRequestConversationItems,
  type PullRequestConversationItem,
} from './pull-request-conversation';

function commentAuthorLabel(comment: PullRequestConversationItem): string {
  return comment.author?.displayName ?? comment.author?.userName ?? 'Unknown author';
}

function commentLocationLabel(comment: PullRequestConversationItem): string | null {
  if (!comment.path) return null;
  return comment.line ? `${comment.path}:${comment.line}` : comment.path;
}

function isBotAuthor(comment: PullRequestConversationItem): boolean {
  return comment.author?.userName.endsWith('[bot]') ?? false;
}

function CommentItem({ comment }: { comment: PullRequestConversationItem }) {
  const location = commentLocationLabel(comment);
  const author = commentAuthorLabel(comment);
  const avatarRadiusClass = isBotAuthor(comment) ? 'rounded' : 'rounded-full';
  const openLink = useMarkdownLinkOpener();

  return (
    <div className="group/comment flex w-full min-w-0 gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover">
      {comment.author?.avatarUrl ? (
        <img
          src={comment.author.avatarUrl}
          alt={author}
          className={cn('mt-0.5 size-5 shrink-0', avatarRadiusClass)}
        />
      ) : (
        <div
          aria-hidden
          className={cn(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center bg-surface-emphasis text-foreground-passive',
            avatarRadiusClass
          )}
        >
          <MessageSquare className="size-3" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{author}</span>
          <span className="flex min-w-0 shrink-0 items-baseline gap-1 text-tiny text-foreground-passive tabular-nums">
            <RelativeTime compact value={comment.createdAt} />
            {comment.isResolved && <span>· Resolved</span>}
            {comment.isOutdated && <span>· Outdated</span>}
          </span>
        </div>
        {location && (
          <div className="mt-0.5 truncate font-mono text-tiny text-foreground-passive">
            {location}
          </div>
        )}
        <div
          className={cn(
            'mt-1 text-xs leading-relaxed break-words [&_*:last-child]:mb-0 [&_p]:mb-1.5',
            comment.isOutdated || comment.isResolved
              ? 'text-foreground-passive'
              : 'text-foreground-body'
          )}
        >
          <Markdown content={comment.body} variant="compact" allowHtml onOpenLink={openLink} />
        </div>
      </div>
      <Button
        variant="ghost"
        size="xs"
        icon
        aria-label="Open comment on GitHub"
        className="-mt-0.5 shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-visible:opacity-100"
        onClick={() => void openExternal(comment.url)}
      >
        <ExternalLink className="size-3.5" />
      </Button>
    </div>
  );
}

function CommentsNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-xs text-foreground-passive">{children}</p>;
}

export function CommentsList({
  comments,
  isLoading,
  error,
}: {
  comments: PullRequestConversationItem[];
  isLoading?: boolean;
  error?: Error | null;
}) {
  const sorted = useMemo(() => [...comments].sort(sortPullRequestConversationItems), [comments]);

  if (isLoading && sorted.length === 0) {
    return <CommentsNote>Loading comments…</CommentsNote>;
  }

  if (error && sorted.length === 0) {
    return <CommentsNote>Unable to load comments</CommentsNote>;
  }

  if (sorted.length === 0) {
    return <CommentsNote>No comments yet</CommentsNote>;
  }

  return (
    <div className="flex flex-col">
      {sorted.map((comment) => (
        <CommentItem key={comment.id} comment={comment} />
      ))}
      {isLoading && <CommentsNote>Loading comments…</CommentsNote>}
      {error && <CommentsNote>Unable to load comments</CommentsNote>}
    </div>
  );
}
