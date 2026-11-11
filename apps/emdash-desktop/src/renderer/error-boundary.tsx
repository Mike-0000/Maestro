import { Button, Collapsible } from '@emdash/ui/react/primitives';
import { ChevronRight, RotateCw } from 'lucide-react';
import React from 'react';
import { getMementoClient } from '@core/primitives/mementos/browser';

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  isRecovering: boolean;
  recoveryError: string | null;
};

type ErrorBoundaryProps = {
  children?: React.ReactNode;
};

// The kit trigger is a full-width ghost row: a fit-width wrapper keeps it to its words, lined up
// with the text above (the negative margin cancels its padding); the label is muted until hovered.
const DISCLOSURE_TRIGGER = 'group h-7';
const DISCLOSURE_LABEL =
  'flex items-center gap-1.5 text-sm text-foreground-muted transition-colors group-hover:text-foreground';

function ErrorFallback({
  message,
  onReload,
  onReset,
  isRecovering,
  recoveryError,
}: {
  message: string;
  onReload: () => void;
  onReset: () => void;
  isRecovering: boolean;
  recoveryError: string | null;
}) {
  // The page-level error pattern (design brief 2.12) on the plain content surface: the error
  // dot and a hero line, one sentence, the one move, then two quiet disclosures: the technical
  // detail, and the heavier reset for when a reload is not enough.
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="w-full max-w-md motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in">
        <span aria-hidden className="block size-2 rounded-full bg-foreground-error" />
        <h1 className="mt-5 text-2xl font-medium text-balance">
          Maestro couldn’t display that view
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-muted">
          Reload to try again with your saved layout.
        </p>
        <Button variant="primary" className="mt-6" onClick={onReload} disabled={isRecovering}>
          <RotateCw className="size-3.5" aria-hidden />
          Reload app
        </Button>
        {recoveryError && (
          <p role="alert" className="mt-4 text-xs text-foreground-error">
            {recoveryError}
          </p>
        )}
        <div className="mt-10 flex flex-col gap-4">
          <Collapsible.Root>
            <div className="-ml-2 w-fit">
              <Collapsible.Trigger hideChevron className={DISCLOSURE_TRIGGER}>
                <span className={DISCLOSURE_LABEL}>
                  <ChevronRight
                    className="size-3 text-foreground-passive transition-transform group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
                    aria-hidden
                  />
                  Error details
                </span>
              </Collapsible.Trigger>
            </div>
            <Collapsible.Panel>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface-emphasis px-3 py-2.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground-muted select-text">
                {message}
              </pre>
            </Collapsible.Panel>
          </Collapsible.Root>
          <Collapsible.Root disabled={isRecovering}>
            <div className="-ml-2 w-fit">
              <Collapsible.Trigger hideChevron className={DISCLOSURE_TRIGGER}>
                <span className={DISCLOSURE_LABEL}>
                  <ChevronRight
                    className="size-3 text-foreground-passive transition-transform group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
                    aria-hidden
                  />
                  Still having trouble?
                </span>
              </Collapsible.Trigger>
            </div>
            <Collapsible.Panel>
              <p className="mt-2 pl-4.5 text-xs leading-relaxed text-foreground-muted">
                Reset saved UI state to try a fresh layout. This clears layouts, navigation, project
                order, and unsent drafts. Projects, files, and saved conversations are kept.
              </p>
              <div className="mt-3 pl-4.5">
                <Button variant="destructive" size="sm" onClick={onReset} disabled={isRecovering}>
                  Reset UI state and reload
                </Button>
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private recovering = false;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, isRecovering: false, recoveryError: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  handleReload = () => {
    void this.recover(false);
  };

  handleReset = () => {
    void this.recover(true);
  };

  private async recover(resetUiState: boolean): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    this.setState({ isRecovering: true, recoveryError: null });
    try {
      const client = getMementoClient();
      if (resetUiState) {
        // Discard pending drafts before deleting saved state so beforeunload cannot restore it.
        await client.deleteAll();
      } else {
        await client.flush();
      }
    } catch {
      // Ordinary reload is best effort; a failed reset must remain visible and retryable.
      if (resetUiState) {
        this.recovering = false;
        this.setState({
          isRecovering: false,
          recoveryError: 'Could not reset UI state. Try again, or use Reload to restart the app.',
        });
        return;
      }
    }
    try {
      window.location.reload();
    } catch {
      this.recovering = false;
      this.setState({
        isRecovering: false,
        recoveryError: 'Could not reload the app. Try again.',
      });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children as React.ReactElement;
    const message = this.state.error?.message || 'An unexpected error occurred.';
    return (
      <ErrorFallback
        message={message}
        onReload={this.handleReload}
        onReset={this.handleReset}
        isRecovering={this.state.isRecovering}
        recoveryError={this.state.recoveryError}
      />
    );
  }
}
