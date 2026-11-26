import { Button } from '@emdash/ui/react/primitives';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { errorMessage } from './client-session-format';
import type { ClientSession } from './client-session-store';

/**
 * Where a link state is shown: `page` is the whole window before the app has booted (one centred
 * column, hero line), `dialog` is the card over the running app (dialog title, footer actions).
 */
export type PanelVariant = 'page' | 'dialog';

/**
 * One link state in words: what is happening, one sentence on what to do, an optional body, the
 * one move and the quiet alternatives. The same content reads as a page or as a dialog.
 */
export function StatePanel({
  variant,
  title,
  description,
  detail,
  children,
  primary,
  secondary,
  error,
  titleId,
  descriptionId,
}: {
  variant: PanelVariant;
  title: ReactNode;
  description?: ReactNode;
  /** Technical detail from the host, shown small and in mono under the sentence. */
  detail?: ReactNode;
  children?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  error?: string | null;
  titleId?: string;
  descriptionId?: string;
}) {
  const page = variant === 'page';
  const Title = page ? 'h1' : 'h2';
  return (
    <div className={cn('flex w-full flex-col', page && 'items-center text-center')}>
      <Title
        id={titleId}
        className={cn(
          'text-balance text-foreground',
          page ? 'text-2xl font-medium' : 'text-lg font-semibold'
        )}
      >
        {title}
      </Title>
      {description != null && (
        <p
          id={descriptionId}
          className={cn(
            'text-sm text-foreground-muted',
            page ? 'mt-3 max-w-sm leading-relaxed text-balance' : 'mt-1.5'
          )}
        >
          {description}
        </p>
      )}
      {detail != null && (
        <p
          className={cn(
            'mt-3 font-mono text-xs break-words text-foreground-passive',
            page && 'max-w-sm'
          )}
        >
          {detail}
        </p>
      )}
      {children != null && <div className={cn('w-full', page ? 'mt-8' : 'mt-5')}>{children}</div>}
      {error ? (
        <div className={cn('flex', page ? 'mt-5 justify-center' : 'mt-4')}>
          <InlineError>{error}</InlineError>
        </div>
      ) : null}
      {(primary != null || secondary != null) &&
        (page ? (
          <div className="mt-8 flex flex-col items-center gap-5">
            {primary != null && (
              <div className="flex flex-wrap items-center justify-center gap-2">{primary}</div>
            )}
            {secondary != null && (
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                {secondary}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">{secondary}</div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{primary}</div>
          </div>
        ))}
    </div>
  );
}

/** A plain-words error near the move: the error dot, then the message. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex max-w-sm items-start gap-2 text-left text-xs text-foreground-error"
    >
      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

export type SessionActionRunner = {
  /** The key of the action in flight, or null. */
  pending: string | null;
  error: string | null;
  run(key: string, action: () => Promise<unknown>): void;
  clearError(): void;
};

/** Runs one link action at a time and keeps what went wrong for the panel to show. */
export function useSessionAction(): SessionActionRunner {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((key: string, action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    setError(null);
    void action()
      .catch((cause: unknown) => {
        if (mounted.current) setError(errorMessage(cause));
      })
      .finally(() => {
        busy.current = false;
        if (mounted.current) setPending(null);
      });
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { pending, error, run, clearError };
}

/**
 * "Forget this host", confirmed in place: these screens show before the app's modals exist, and
 * forgetting cannot be undone without a new pairing code.
 */
export function ForgetHostAction({
  session,
  hostName,
  disabled,
}: {
  session: ClientSession;
  hostName: string;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!confirming) {
    return (
      <Button type="button" variant="text" disabled={disabled} onClick={() => setConfirming(true)}>
        Forget this host
      </Button>
    );
  }

  const forget = () => {
    setWorking(true);
    setFailure(null);
    // On success the client relaunches, so there is nothing to reset.
    session.forget().catch((cause: unknown) => {
      setWorking(false);
      setFailure(errorMessage(cause));
    });
  };

  return (
    <span
      role="group"
      aria-label={`Forget ${hostName}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-muted"
    >
      <span>{failure ?? `Forget ${hostName}? Pairing again needs a new code.`}</span>
      <Button type="button" variant="text" tone="destructive" disabled={working} onClick={forget}>
        {working ? 'Forgetting…' : 'Forget'}
      </Button>
      <Button
        type="button"
        variant="text"
        disabled={working}
        onClick={() => {
          setConfirming(false);
          setFailure(null);
        }}
      >
        Keep
      </Button>
    </span>
  );
}

/** Quits the client; the host carries on. */
export function QuitAction({ session, disabled }: { session: ClientSession; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="text"
      disabled={disabled}
      onClick={() => void session.quit().catch(() => {})}
    >
      Disconnect and quit
    </Button>
  );
}
