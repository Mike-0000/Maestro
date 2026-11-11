import { sshConnectionIdOf, type HostRef } from '@emdash/core/primitives/host/api';
import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Dialog, Spinner, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { reaction } from 'mobx';
import { useEffect, useRef, useState } from 'react';
import { AcpAuthLoginBinding } from '@core/features/agents/api/browser/auth-login-binding';
import { checkClaudeAccountSignIn } from '@core/features/claude-accounts/contributions/browser/sign-in-check';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { isPrimaryMouseButton } from '@core/features/terminals/api/browser/pty/file-link-provider';
import {
  buildTheme,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PADDING_PX,
} from '@core/features/terminals/api/browser/pty/pty';
import { buildTerminalFontFamily } from '@core/features/terminals/api/browser/pty/terminal-font';
import { getCellMetrics } from '@core/features/terminals/api/browser/pty/xterm-cell-metrics';
import { confirmOpenExternalLink } from '@core/features/workbench/api/browser/open-external-link';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { TERMINAL_FONT_SIZE_DEFAULT } from '@core/primitives/terminals/api';
import { planLoginGrid, type LoginHostSize } from './login-terminal-grid';

export type AgentSignInModalArgs = {
  providerId: string;
  methodId: string;
  providerName: string;
  /** Host the sign-in runs on; remote hosts show the machine's name in the title. */
  host: HostRef;
  /**
   * Sign in to this Claude account instead of the provider's own sign-in. The dialog then
   * finishes when the sign-in command exits, not when the provider reports signed in: that is
   * already true while the primary account is signed in.
   */
  claudeAccount?: { id: string; label: string };
};

/** Where an account sign-in stands once its terminal is up. */
type AccountSignInPhase =
  | { kind: 'terminal' }
  | { kind: 'checking' }
  | { kind: 'not-signed-in' }
  | { kind: 'failed'; message: string };

/** Resolves the display name of the machine behind a remote host ref (null for local). */
function useMachineName(host: HostRef): string | null {
  const connectionId = sshConnectionIdOf(host);
  const { data } = useQuery({
    queryKey: ['machines', 'name', connectionId],
    queryFn: async () => (await getMachinesClient()).getMachines(undefined),
    enabled: connectionId !== undefined,
    staleTime: 60 * 1000,
  });
  if (!connectionId) return null;
  return data?.find((connection) => connection.id === connectionId)?.name ?? null;
}

export function AgentSignInModal({
  providerId,
  methodId,
  providerName,
  host,
  claudeAccount,
}: AgentSignInModalArgs) {
  const modal = useModalController('agentSignInModal');
  const machineName = useMachineName(host);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const claudeAccountId = claudeAccount?.id;
  const claudeAccountLabel = claudeAccount?.label;
  const [accountPhase, setAccountPhase] = useState<AccountSignInPhase>({ kind: 'terminal' });
  // Bumped by "Try again" to start a fresh terminal and login.
  const [attempt, setAttempt] = useState(0);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<AcpAuthLoginBinding | null>(null);
  const handledUrlsRef = useRef(new Set<string>());
  const completeRef = useRef(modal.complete);
  completeRef.current = modal.complete;

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    if (!terminalHost) return;

    let disposed = false;
    let animationFrame: number | null = null;
    let metricsRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAppliedHostSize: LoginHostSize | null = null;
    let measuredDims: { cols: number; rows: number } | null = null;
    const terminal = createLoginTerminal();
    terminal.open(terminalHost);
    styleLoginTerminal(terminal);
    terminal.focus();

    const inputDisposable = terminal.onData((data) => {
      bindingRef.current?.sendInput(data);
    });
    const resize = (force = false, metricsRetries = 0) => {
      if (disposed) return;
      const cell = getCellMetrics(terminal);
      if (!cell) {
        // Cold path: xterm's font measurement may not be populated on the
        // first call right after open. Bounded retry to avoid a loop.
        if (metricsRetries < 5) {
          if (metricsRetryTimer !== null) clearTimeout(metricsRetryTimer);
          metricsRetryTimer = setTimeout(() => resize(force, metricsRetries + 1), 100);
        }
        return;
      }
      const hostSize: LoginHostSize = {
        width: terminalHost.clientWidth,
        height: terminalHost.clientHeight,
      };
      const dims = planLoginGrid({
        hostSize,
        cellWidth: cell.width,
        cellHeight: cell.height,
        paddingPx: TERMINAL_PADDING_PX,
        lastAppliedHostSize: force ? null : lastAppliedHostSize,
      });
      if (!dims) return;
      lastAppliedHostSize = hostSize;
      measuredDims = dims;
      if (terminal.cols !== dims.cols || terminal.rows !== dims.rows) {
        terminal.resize(dims.cols, dims.rows);
      }
      bindingRef.current?.resize(dims.cols, dims.rows);
    };
    const observer = new ResizeObserver(() => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => resize());
    });
    observer.observe(terminalHost);
    // Measure before startLogin so the PTY spawns at the real grid. On the
    // cold path (cell metrics not ready yet) this stays null and the server
    // spawns at its defaults; the post-attach resize converges it.
    resize();

    void AcpAuthLoginBinding.create({
      host,
      providerId,
      methodId,
      terminal,
      initialDims: measuredDims ?? undefined,
      claudeAccountId,
    }).then(
      (binding) => {
        if (disposed) {
          void binding.dispose();
          return;
        }
        bindingRef.current = binding;
        setReady(true);
        // Force so the fresh PTY converges to the measured grid even though
        // the host size has not changed since the mount-time resize.
        resize(true);
      },
      (err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    );

    return () => {
      disposed = true;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (metricsRetryTimer !== null) clearTimeout(metricsRetryTimer);
      observer.disconnect();
      inputDisposable.dispose();
      void bindingRef.current?.dispose();
      bindingRef.current = null;
      terminal.dispose();
    };
  }, [host, methodId, providerId, claudeAccountId, attempt]);

  useEffect(() => {
    const binding = bindingRef.current;
    if (!binding || !ready) return;

    if (claudeAccountId !== undefined) {
      // An account sign-in is over when its command exits. Then ask Claude Code who is signed
      // in, and close on success or say what happened.
      let stopped = false;
      const finish = async () => {
        setAccountPhase({ kind: 'checking' });
        // Also clears the published exit, so the next login starts clean.
        void binding.dispose();
        if (bindingRef.current === binding) bindingRef.current = null;
        const check = await checkClaudeAccountSignIn(claudeAccountId);
        if (stopped) return;
        if (check.kind === 'signed-in') {
          toast.success(`${claudeAccountLabel ?? 'Claude account'} is signed in`, {
            description: check.email,
          });
          completeRef.current();
          return;
        }
        setAccountPhase(check);
      };
      let exited = false;
      const onState = (state: ReturnType<typeof binding.status.current>) => {
        if (exited || !state.login?.exit) return;
        exited = true;
        void finish();
      };
      const unsubscribe = binding.status.subscribe(onState);
      onState(binding.status.current());
      return () => {
        stopped = true;
        unsubscribe();
      };
    }

    return reaction(
      () => binding.status.current(),
      (state) => {
        if (state.status.kind === 'authenticated') {
          void binding.dispose(false);
          bindingRef.current = null;
          completeRef.current();
          return;
        }

        const pendingUrl = state.login?.pendingUrl;
        if (!pendingUrl || handledUrlsRef.current.has(pendingUrl.id)) return;
        handledUrlsRef.current.add(pendingUrl.id);
        confirmOpenExternalLink(pendingUrl.url);
        binding.markUrlHandled(pendingUrl.id);
      },
      { fireImmediately: true }
    );
  }, [ready, claudeAccountId, claudeAccountLabel]);

  const retryAccountSignIn = () => {
    setReady(false);
    setError(null);
    setAccountPhase({ kind: 'terminal' });
    setAttempt((current) => current + 1);
  };

  const description = [
    machineName ? `On ${machineName}` : null,
    claudeAccountLabel ? `Account: ${claudeAccountLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Sign in to {providerName}</Dialog.Title>
        {description ? <Dialog.Description>{description}</Dialog.Description> : null}
      </Dialog.Header>
      <Dialog.Body height={520}>
        <div className="relative h-full overflow-hidden rounded-lg border border-border-subtle bg-(--xterm-bg)">
          <div ref={terminalHostRef} className="h-full" />
          {!ready && !error && (
            <TerminalOverlay>
              <Spinner size="sm" className="text-foreground-passive" />
              <span>Starting the sign-in terminal…</span>
            </TerminalOverlay>
          )}
          {error && (
            <TerminalOverlay>
              <div role="alert" className="flex max-w-sm flex-col items-center gap-2">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <StateGlyph state="error" />
                  Could not start the sign-in terminal
                </p>
                <p className="font-mono text-xs break-all text-foreground-muted">{error}</p>
              </div>
            </TerminalOverlay>
          )}
          {!error && accountPhase.kind === 'checking' && (
            <TerminalOverlay>
              <Spinner size="sm" className="text-foreground-passive" />
              <span>Checking the sign-in…</span>
            </TerminalOverlay>
          )}
          {!error && (accountPhase.kind === 'not-signed-in' || accountPhase.kind === 'failed') && (
            <TerminalOverlay>
              <div role="status" className="flex max-w-sm flex-col items-center gap-1">
                <p className="font-medium text-foreground">
                  {accountPhase.kind === 'not-signed-in'
                    ? `${claudeAccountLabel ?? 'This account'} isn't signed in yet`
                    : "Couldn't check the sign-in"}
                </p>
                <p className="text-foreground-muted">
                  {accountPhase.kind === 'not-signed-in'
                    ? 'The sign-in ended before it finished.'
                    : accountPhase.message}
                </p>
                <Button variant="text" size="sm" className="mt-3" onClick={retryAccountSignIn}>
                  Try again
                </Button>
              </div>
            </TerminalOverlay>
          )}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={modal.dismiss}>
          Close
        </Button>
      </Dialog.Footer>
    </>
  );
}

/** A centred note over the terminal (starting, checking, failed), on the dialog's surface. */
function TerminalOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="surface-elevated absolute inset-0 flex items-center justify-center gap-2 bg-surface/90 p-6 text-center text-sm text-foreground-muted">
      {children}
    </div>
  );
}

export const agentSignInModal = defineModal<void>()({
  id: 'agentSignInModal',
  component: AgentSignInModal,
  size: 'lg',
});

function createLoginTerminal(): Terminal {
  const terminal = new Terminal({
    // Placeholder grid until the mount-time resize measures the real cells.
    cols: 120,
    rows: 32,
    // Short-lived login flow: a screenful of context is plenty.
    scrollback: 1_000,
    fontFamily: buildTerminalFontFamily(),
    fontSize: TERMINAL_FONT_SIZE_DEFAULT,
    lineHeight: TERMINAL_LINE_HEIGHT,
    letterSpacing: TERMINAL_LETTER_SPACING,
    allowProposedApi: true,
    scrollOnUserInput: false,
    linkHandler: {
      activate: (event, text) => {
        if (!isPrimaryMouseButton(event)) return;
        confirmOpenExternalLink(text);
      },
    },
    theme: buildTheme(),
  });
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!isPrimaryMouseButton(event)) return;
      event.preventDefault();
      confirmOpenExternalLink(uri);
    })
  );
  return terminal;
}

function styleLoginTerminal(terminal: Terminal): void {
  const element = (terminal as unknown as { element?: HTMLElement }).element;
  if (!element) return;
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.boxSizing = 'border-box';
  element.style.padding = `${TERMINAL_PADDING_PX}px`;
  element.style.backgroundColor = 'var(--xterm-bg)';
}
