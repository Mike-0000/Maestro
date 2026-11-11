import { Markdown } from '@emdash/ui/react/components';
import {
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Hand,
  Plus,
  Send,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { cn } from '@core/primitives/styling/browser/cn';
import { withoutImages } from '../safe-markdown';
import { currentDigestId } from './current-digest';
import { digestActions } from './digest-actions';
import { DigestCard } from './digest-card';
import { InlineText } from './inline-text';
import type { ActionEntry, LineEmphasis, ThreadBlock } from './thread-view';
import { workLabelParts } from './work-label-parts';

const ACTION_ICONS: Record<string, LucideIcon> = {
  send_to_agent: Send,
  interrupt_agent: Hand,
  answer_prompt: ShieldCheck,
  start_agent: Plus,
};

/** The keyboard focus mark for the thread's own plain buttons. */
const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';

function entryTime(at: string): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

/** What the developer wrote: a quiet bubble on the right. */
function DeveloperBubble({ text, at }: { text: string; at: string }) {
  return (
    <div
      className="flex justify-end pl-[20%] motion-safe:animate-in motion-safe:duration-200 motion-safe:fade-in"
      title={entryTime(at)}
    >
      <div className="max-w-full rounded-lg bg-background-2 px-4 py-2.5 text-base break-words whitespace-pre-wrap text-foreground select-text">
        {text}
      </div>
    </div>
  );
}

/**
 * A spoken line takes its size from how recent it is: the newest is large and bright, the one or
 * two before it smaller, and the rest recede into body text. A narrow pane brings the newest down
 * a step.
 */
const LINE_TYPE: Record<LineEmphasis, string> = {
  latest: 'text-xl text-foreground @max-[34rem]/conductor:text-lg',
  recent: 'text-lg text-foreground-body',
  old: 'text-base text-foreground-muted',
};

/** A message in markdown reads in body type, with its tone from how recent it is. */
const MARKDOWN_TONE: Record<LineEmphasis, string> = {
  latest: 'text-foreground',
  recent: 'text-foreground-body',
  old: 'text-foreground-muted',
};

/** A long or structured message: markdown in body type, whatever its place. */
const ConductorMarkdown = observer(function ConductorMarkdown({
  text,
  emphasis,
}: {
  text: string;
  emphasis: LineEmphasis;
}) {
  const openLink = useMarkdownLinkOpener();
  // Markdown ends every block with a margin; -mb-2 takes the last one back, so the thread's gap
  // alone spaces a message from the block after it.
  return (
    <div className={cn('-mb-2 min-w-0 text-base select-text', MARKDOWN_TONE[emphasis])}>
      <Markdown content={withoutImages(text)} variant="compact" onOpenLink={openLink} />
    </div>
  );
});

function ConductorLine({ block }: { block: Extract<ThreadBlock, { kind: 'line' }> }) {
  return (
    <div
      title={entryTime(block.at)}
      className={cn(
        // The newest line gets more room above it than the thread's usual gap.
        block.emphasis === 'latest' && 'mt-4',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300'
      )}
    >
      {block.markdown ? (
        <ConductorMarkdown text={block.text} emphasis={block.emphasis} />
      ) : (
        <p
          className={cn(
            'break-words text-pretty whitespace-pre-wrap select-text',
            LINE_TYPE[block.emphasis]
          )}
        >
          <InlineText text={block.text} />
        </p>
      )}
    </div>
  );
}

/** One thing the conductor did: a quiet line, opening to the exact text it sent. */
function ActionRow({ entry }: { entry: ActionEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = entry.status === 'refused' ? CircleSlash : (ACTION_ICONS[entry.tool] ?? Send);
  const tone =
    entry.status === 'failed'
      ? 'text-foreground-error'
      : entry.status === 'refused'
        ? 'text-foreground-warning'
        : 'text-foreground-muted';
  const icon = <Icon aria-hidden className="mt-[3px] size-3.5 shrink-0 opacity-80" />;
  if (!entry.detail) {
    return (
      <li className={cn('flex items-start gap-2.5 py-0.5', tone)} title={entryTime(entry.at)}>
        {icon}
        <span className="min-w-0 break-words">{entry.summary}</span>
      </li>
    );
  }
  return (
    <li title={entryTime(entry.at)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'group/step -mx-2 flex max-w-[calc(100%+1rem)] items-start gap-2.5 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-surface-hover',
          FOCUS_RING,
          tone
        )}
      >
        {icon}
        <span className="min-w-0 break-words">
          {entry.summary}
          <ChevronRight
            aria-hidden
            className={cn(
              'ml-1 inline size-3.5 align-[-2px] opacity-50 group-hover/step:opacity-90 motion-safe:transition-transform',
              open && 'rotate-90'
            )}
          />
        </span>
      </button>
      {open && (
        <pre className="mt-1.5 mb-1 ml-6 max-h-80 overflow-auto rounded-md bg-surface-emphasis px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground select-text">
          {entry.detail}
        </pre>
      )}
    </li>
  );
}

/**
 * A run of things the conductor did, folded into one underlined line ("Worked for 1m 34s · 4
 * steps"). It opens by itself when a step failed or was refused.
 */
function WorkDisclosure({ block }: { block: Extract<ThreadBlock, { kind: 'work' }> }) {
  const [open, setOpen] = useState(block.openByDefault);
  // The block stays mounted while a live turn appends steps, so a step that fails later opens it
  // here, once: the moment `openByDefault` turns true. Closed by hand after that, it stays closed.
  const [openedByDefault, setOpenedByDefault] = useState(block.openByDefault);
  if (block.openByDefault !== openedByDefault) {
    setOpenedByDefault(block.openByDefault);
    if (block.openByDefault) setOpen(true);
  }
  const parts = workLabelParts(block);
  const listId = `${block.id}-steps`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          '-mx-1 rounded-sm px-1 text-sm text-foreground-muted underline decoration-foreground-passive/50 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground-muted',
          FOCUS_RING
        )}
      >
        {parts.map((part, index) => (
          <span
            key={index}
            className={cn(
              part.tone === 'warning' && 'text-foreground-warning',
              part.tone === 'error' && 'text-foreground-error'
            )}
          >
            {index > 0 && <span className="text-foreground-passive"> · </span>}
            {part.text}
          </span>
        ))}
      </button>
      {open && (
        <ul
          id={listId}
          className="mt-2.5 flex flex-col gap-1 text-sm motion-safe:animate-in motion-safe:duration-200 motion-safe:fade-in"
        >
          {block.actions.map((entry) => (
            <ActionRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A chat event marker ("The agent finished a turn"): small, centred, no rules beside it. */
function EventMarker({ text, at }: { text: string; at: string }) {
  return (
    <div
      role="separator"
      aria-label={text}
      title={entryTime(at)}
      className="px-6 text-center text-tiny text-foreground-passive"
    >
      {text}
    </div>
  );
}

function ErrorAlert({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-border-destructive/35 bg-background-destructive/50 px-4 py-3 text-sm text-foreground-destructive select-text"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{text}</span>
    </div>
  );
}

export interface ThreadBlocksProps {
  blocks: readonly ThreadBlock[];
  nowMs: number;
  /** The task's dev server origins: the only addresses a report's "Open app" may open. */
  devServerOrigins: readonly string[];
  onDone: () => Promise<void> | void;
  onMerge: (() => void) | null;
  onOpenApp: (url: string) => void;
  onShowRaw: () => void;
}

/** The thread's blocks in order, each drawn by its kind. */
export function ThreadBlocks({
  blocks,
  nowMs,
  devServerOrigins,
  onDone,
  onMerge,
  onOpenApp,
  onShowRaw,
}: ThreadBlocksProps) {
  const current = currentDigestId(blocks);
  return blocks.map((block) => {
    switch (block.kind) {
      case 'developer':
        return <DeveloperBubble key={block.id} text={block.text} at={block.at} />;
      case 'line':
        return <ConductorLine key={block.id} block={block} />;
      case 'work':
        return <WorkDisclosure key={block.id} block={block} />;
      case 'event':
        return <EventMarker key={block.id} text={block.text} at={block.at} />;
      case 'error':
        return <ErrorAlert key={block.id} text={block.text} />;
      case 'digest':
        return (
          <DigestCard
            key={block.id}
            block={block}
            current={block.id === current}
            nowMs={nowMs}
            actions={digestActions({
              digest: block.digest,
              latest: block.id === current,
              canIntegrate: onMerge !== null,
              devServerOrigins,
            })}
            onDone={onDone}
            onMerge={onMerge}
            onOpenApp={onOpenApp}
            onShowRaw={onShowRaw}
          />
        );
    }
  });
}
