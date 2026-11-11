import { BrailleSpinner, StateGlyph } from '@emdash/ui/react/components';
import { Button, Dialog, ModalLayout, Spinner, useToast } from '@emdash/ui/react/primitives';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getGithubClient } from '@core/features/github/api/browser/client';
import { useModalController } from '@core/manifests/browser/modal-api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import type { GitHubUser } from '@core/primitives/github/api';
import { log } from '@core/primitives/logging/browser/logger';
import { defineModal } from '@core/primitives/modals/react';
import { EMDASH_ISSUES_URL } from '@core/primitives/urls/api/urls';

export type GithubDeviceFlowModalArgs = {
  onError?: (error: string) => void;
};

export function GithubDeviceFlowModal({ onError }: GithubDeviceFlowModalArgs) {
  const modal = useModalController('githubDeviceFlowModal');
  const { toast } = useToast();
  const cancelGithubConnect = useCallback(() => {
    void getGithubClient().then((client) => client.authCancel(undefined));
    toast('GitHub connection unsuccessful', { description: 'Device flow was canceled' });
  }, [toast]);

  // Presentational state - updated via IPC events from main process
  const [userCode, setUserCode] = useState<string>('');
  const [verificationUri, setVerificationUri] = useState<string>('');
  const [timeRemaining, setTimeRemaining] = useState<number>(900);
  const [copied, setCopied] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserOpenCountdown, setBrowserOpenCountdown] = useState(3);

  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasAutocopied = useRef(false);
  const hasOpenedBrowser = useRef(false);
  const authSucceededRef = useRef(false);
  const completeRef = useRef(modal.complete);
  completeRef.current = modal.complete;

  // Cancel the auth flow if the modal is dismissed before auth completes
  useEffect(() => {
    return () => {
      if (!authSucceededRef.current) {
        cancelGithubConnect();
      }
    };
  }, [cancelGithubConnect]);

  // Countdown timer for code expiration
  useEffect(() => {
    if (success || error) return;

    countdownIntervalRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          setError('Code expired. Please try again.');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [success, error]);

  // Reset state on mount (new auth flow)
  useEffect(() => {
    setSuccess(false);
    setError(null);
    setUser(null);
    setCopied(false);
    hasAutocopied.current = false;
    hasOpenedBrowser.current = false;
  }, []);

  const copyToClipboard = useCallback(
    async (code: string, isAutomatic = false) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(code);
        } else {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = code;
          textArea.style.position = 'fixed';
          textArea.style.left = '-999999px';
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }

        setCopied(true);

        if (!isAutomatic) {
          toast('Code copied', { description: 'Paste it on GitHub to authorize.' });
        }

        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        log.error('Failed to copy:', err);
        if (!isAutomatic) {
          toast.error('Copy failed', { description: 'Please copy the code manually' });
        }
      }
    },
    [toast]
  );

  const openGitHub = useCallback(() => {
    if (verificationUri) {
      void openExternal(verificationUri);
    }
  }, [verificationUri]);

  // Subscribe to auth events from main process
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getGithubClient().then(async (client) => {
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (event.type === 'device-code') {
            setUserCode(event.userCode);
            setVerificationUri(event.verificationUri);
            setTimeRemaining(event.expiresIn);
            if (!hasAutocopied.current) {
              hasAutocopied.current = true;
              void copyToClipboard(event.userCode, true);
              setBrowserOpening(true);
              let countdown = 3;
              const countdownTimer = setInterval(() => {
                countdown--;
                setBrowserOpenCountdown(countdown);
                if (countdown <= 0) clearInterval(countdownTimer);
              }, 1000);
              setTimeout(() => {
                setBrowserOpening(false);
                if (!hasOpenedBrowser.current) {
                  hasOpenedBrowser.current = true;
                  void openExternal(event.verificationUri);
                }
              }, 3000);
            }
          } else if (event.type === 'auth-success') {
            authSucceededRef.current = true;
            setSuccess(true);
            setUser(event.user);
            setTimeout(() => completeRef.current(), 1000);
          } else if (event.type === 'auth-error') {
            setError(event.message || event.error);
            onError?.(event.error);
            toast.error('Authentication failed', {
              description: event.message || 'An error occurred',
            });
          }
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [copyToClipboard, onError, toast]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Keyboard shortcuts (Escape is handled by DialogContent's onEscapeKeyDown)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        void copyToClipboard(userCode);
      } else if (e.key === 'Enter') {
        openGitHub();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        openGitHub();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [copyToClipboard, openGitHub, userCode]);

  const title = success ? 'GitHub connected' : error ? 'Authorization failed' : 'Authorize GitHub';

  return (
    <ModalLayout
      title={title}
      description={
        success || error ? undefined : 'Enter this one-time code on GitHub to authorize Emdash.'
      }
      leading={
        success || error ? undefined : (
          <Button variant="text" size="sm" onClick={() => openExternal(EMDASH_ISSUES_URL)}>
            Having trouble?
          </Button>
        )
      }
      actions={
        error || success ? (
          <Button variant="ghost" onClick={modal.dismiss}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={modal.dismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={openGitHub}
              disabled={!verificationUri || browserOpening}
            >
              <ExternalLink className="size-3.5" />
              Open GitHub
            </Button>
          </>
        )
      }
    >
      <Dialog.Body className="gap-4">
        {success ? (
          <div className="flex items-center gap-3">
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt="" className="size-8 shrink-0 rounded-full" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">You&apos;re connected to GitHub</p>
              {user ? (
                <p className="truncate text-xs text-foreground-muted">@{user.login}</p>
              ) : null}
            </div>
          </div>
        ) : error ? (
          <div role="alert" className="flex items-start gap-2">
            <StateGlyph state="error" className="mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-foreground">GitHub did not authorize Emdash.</p>
              <p className="mt-1 text-xs break-words text-foreground-muted">{error}</p>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => copyToClipboard(userCode)}
              disabled={!userCode}
              className="group/code flex min-h-20 flex-col items-center justify-center gap-1 rounded-lg bg-surface-emphasis px-4 py-4 transition-colors outline-none hover:bg-surface-emphasis-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
              aria-label={copied ? 'Code copied' : 'Copy authorization code'}
            >
              {userCode ? (
                <>
                  <span className="font-mono text-2xl text-foreground select-all">{userCode}</span>
                  <span className="flex items-center gap-1 text-xs text-foreground-passive group-hover/code:text-foreground-muted">
                    {copied ? (
                      <Check className="size-3" aria-hidden />
                    ) : (
                      <Copy className="size-3" aria-hidden />
                    )}
                    {copied ? 'Copied' : 'Click to copy'}
                  </span>
                </>
              ) : (
                <span className="flex items-center gap-2 text-sm text-foreground-muted">
                  <Spinner size="sm" className="text-foreground-passive" />
                  Waiting for GitHub…
                </span>
              )}
            </button>

            <p className="text-sm text-foreground-muted">
              The code is already on your clipboard. Paste it on GitHub, then authorize Emdash.
            </p>

            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-passive tabular-nums">
              <BrailleSpinner variant="wave" className="text-foreground-passive" />
              <span>
                {browserOpening
                  ? `Opening GitHub in ${browserOpenCountdown}s…`
                  : 'Waiting for authorization'}
              </span>
              {timeRemaining > 0 ? (
                <span>· Code expires in {formatTime(timeRemaining)}</span>
              ) : null}
            </p>
          </>
        )}
      </Dialog.Body>
    </ModalLayout>
  );
}

export const githubDeviceFlowModal = defineModal<void>()({
  id: 'githubDeviceFlowModal',
  component: GithubDeviceFlowModal,
  size: 'md',
});
