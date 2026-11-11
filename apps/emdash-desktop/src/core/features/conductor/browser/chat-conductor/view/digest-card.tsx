import { FactGrid } from '@emdash/ui/react/patterns';
import { Button, DropdownMenu, Tooltip } from '@emdash/ui/react/primitives';
import { Ellipsis } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import type { DigestActions } from './digest-actions';
import { InlineText } from './inline-text';
import type { ThreadBlock } from './thread-view';
import { formatAge } from './vitals';

type DigestBlock = Extract<ThreadBlock, { kind: 'digest' }>;

/** When the developer asked, as a fixed local time; null for an unreadable timestamp. */
function askedTime(at: string): string | null {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/** One line of the report's body, led by its word in full strength ("Did:", "Status:"). */
function Point({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <li className="relative pl-4 before:absolute before:top-[0.7em] before:left-0.5 before:size-1 before:rounded-full before:bg-foreground-passive">
      <span className="font-semibold text-foreground">{lead}:</span> {children}
    </li>
  );
}

/** A quiet action in the card's row: the kit's underlined text action in the muted tone. */
function TextAction({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button type="button" variant="text" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export interface DigestCardProps {
  block: DigestBlock;
  /** The report the developer is answering now (see `currentDigestId`). */
  current: boolean;
  actions: DigestActions;
  nowMs: number;
  /** Done; while a returned promise is pending, the button is disabled. */
  onDone: () => Promise<void> | void;
  onMerge: (() => void) | null;
  onOpenApp: (url: string) => void;
  onShowRaw: () => void;
}

/**
 * The conductor's report, in the same shape every time: a headline, what was done and where
 * things stand, then what the developer asked, where the work is and their move, and the actions
 * that settle it. The current report sits on the reading surface like the rest of the thread; an
 * earlier one draws back into a quiet card and keeps only its app link.
 */
export function DigestCard({
  block,
  current,
  actions,
  nowMs,
  onDone,
  onMerge,
  onOpenApp,
  onShowRaw,
}: DigestCardProps) {
  const { digest, askedAt } = block;
  const [firstDid, ...moreDid] = digest.did;
  const merge = actions.merge && onMerge ? onMerge : null;
  // An earlier report keeps its app link only when the address may be opened at all.
  const openApp = current || (actions.openApp && 'url' in actions.openApp) ? actions.openApp : null;
  const showRaw = current;
  const hasTextActions = merge !== null || openApp !== null || showRaw;

  // Done runs once at a time: it stays disabled until the archive it started settles.
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);
  const done = () => {
    if (finishingRef.current) return;
    const pending = onDone();
    if (!(pending instanceof Promise)) return;
    finishingRef.current = true;
    setFinishing(true);
    void pending.finally(() => {
      finishingRef.current = false;
      setFinishing(false);
    });
  };

  return (
    <article
      aria-label={`Report: ${digest.headline}`}
      className={cn(
        'min-w-0 text-base select-text motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in',
        current ? 'mt-4' : 'rounded-lg border border-border-subtle bg-surface-emphasis px-5 py-4'
      )}
    >
      <h3 className="leading-snug font-semibold text-pretty text-foreground">
        <InlineText text={digest.headline} />
      </h3>

      <ul className="mt-3 space-y-1.5 text-foreground-body">
        <Point lead="Did">
          {moreDid.length === 0 ? (
            <InlineText text={firstDid ?? ''} />
          ) : (
            <ul className="mt-1 space-y-1">
              {digest.did.map((item, index) => (
                <li key={index} className="flex gap-2">
                  <span aria-hidden className="text-foreground-passive">
                    –
                  </span>
                  <span className="min-w-0">
                    <InlineText text={item} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Point>
        <Point lead="Status">
          <InlineText text={digest.status} />
        </Point>
        <Point lead="Next">
          <InlineText text={digest.next} />
        </Point>
        {digest.risk && (
          <Point lead="Risk">
            <InlineText text={digest.risk} />
          </Point>
        )}
        {digest.caveat && (
          <Point lead="Caveat">
            <InlineText text={digest.caveat} />
          </Point>
        )}
      </ul>

      <FactGrid size="reading" className="mt-5">
        <FactGrid.Row label="You asked">
          <InlineText text={digest.asked} />
          {askedAt && (
            <>
              {/* The age ticks while the thread is live; screen readers get a fixed time instead,
                  so the thread's live region does not announce every tick. */}
              <span aria-hidden className="text-foreground-passive">
                {' '}
                · {formatAge(askedAt, nowMs)}
              </span>
              {askedTime(askedAt) && <span className="sr-only">, asked {askedTime(askedAt)}</span>}
            </>
          )}
        </FactGrid.Row>
        <FactGrid.Row label="Where it is">
          <InlineText text={digest.where} />
        </FactGrid.Row>
        <FactGrid.Row label="Your move" emphasis>
          <InlineText text={digest.move} />
        </FactGrid.Row>
      </FactGrid>

      {(actions.done || hasTextActions) && (
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
          {actions.done && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={finishing}
              aria-busy={finishing || undefined}
              onClick={done}
            >
              Done
            </Button>
          )}
          {hasTextActions && (
            <span className="contents @max-[24rem]/conductor:hidden">
              {merge && <TextAction onClick={merge}>Merge…</TextAction>}
              {openApp &&
                ('url' in openApp ? (
                  <TextAction onClick={() => onOpenApp(openApp.url)}>Open app</TextAction>
                ) : (
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      render={<span className="inline-flex rounded-sm" tabIndex={0} />}
                    >
                      <TextAction disabled>Open app</TextAction>
                    </Tooltip.Trigger>
                    <Tooltip.Content side="top" align="start" className="max-w-xs">
                      {openApp.refused}
                    </Tooltip.Content>
                  </Tooltip.Root>
                ))}
              {showRaw && <TextAction onClick={onShowRaw}>Show raw</TextAction>}
            </span>
          )}
          {hasTextActions && (
            <span className="hidden @max-[24rem]/conductor:inline-flex">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon
                      aria-label="More actions"
                    />
                  }
                >
                  <Ellipsis aria-hidden />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" side="top" width="content">
                  {merge && <DropdownMenu.Item onClick={merge}>Merge…</DropdownMenu.Item>}
                  {openApp && (
                    <DropdownMenu.Item
                      disabled={!('url' in openApp)}
                      onClick={() => {
                        if ('url' in openApp) onOpenApp(openApp.url);
                      }}
                    >
                      Open app
                    </DropdownMenu.Item>
                  )}
                  {showRaw && <DropdownMenu.Item onClick={onShowRaw}>Show raw</DropdownMenu.Item>}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </span>
          )}
        </div>
      )}
    </article>
  );
}
