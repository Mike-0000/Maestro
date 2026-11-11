import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Dialog, Spinner, useToast } from '@emdash/ui/react/primitives';
import { ChevronRight, Github, KeyRound, type LucideIcon, Terminal } from 'lucide-react';
import { useState } from 'react';
import {
  useAccountLinkProvider,
  useAccountSession,
  useAccountSignIn,
} from '@core/features/account/api/browser/useAccount';
import {
  useGitHubDeviceFlowAuth,
  useImportGitHubCliAccounts,
} from '@core/features/github/api/browser/use-github-auth';
import type { IntegrationAuthUiProps } from '@core/features/integrations/api/browser/integration-auth-ui';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { cn } from '@core/primitives/styling/browser/cn';

type MethodError = {
  method: 'oauth' | 'cli' | 'device_flow';
  message: string;
} | null;

export function GitHubIntegrationAuth({ metadata, onSuccess, onClose }: IntegrationAuthUiProps) {
  const { toast } = useToast();
  const { data: session } = useAccountSession();
  const signInMutation = useAccountSignIn();
  const linkProviderMutation = useAccountLinkProvider();
  const deviceFlowMutation = useGitHubDeviceFlowAuth();
  const importCliAccountsMutation = useImportGitHubCliAccounts();
  const openDeviceFlow = useOpenModal('githubDeviceFlowModal');
  const [oauthLoading, setOauthLoading] = useState(false);
  const [cliLoading, setCliLoading] = useState(false);
  const [error, setError] = useState<MethodError>(null);

  const isSignedIn = session?.isSignedIn === true;
  const hasAccount = session?.hasAccount === true;
  const deviceFlowLoading = deviceFlowMutation.isPending;
  const anyLoading = oauthLoading || cliLoading || deviceFlowLoading;
  const oauthContent = getOAuthContent({ isSignedIn, hasAccount });
  const hasMethod = (kind: string) => metadata.auth.methods.some((method) => method.kind === kind);
  const showDeviceFlowMethod = !hasAccount && hasMethod('oauth-device');

  const connectOAuth = async () => {
    setError(null);
    setOauthLoading(true);
    try {
      const result = isSignedIn
        ? await linkProviderMutation.mutateAsync('github')
        : await signInMutation.mutateAsync('github');

      if (!result.success) {
        setError({
          method: 'oauth',
          message: result.error ?? 'Connection failed. Please try again.',
        });
        return;
      }

      const providerAccount = 'providerAccount' in result ? result.providerAccount : undefined;
      const providerAccountStatus =
        'providerAccountStatus' in result ? result.providerAccountStatus : undefined;

      toast(
        providerAccountStatus === 'updated'
          ? 'GitHub account already connected'
          : 'Connected to GitHub',
        {
          description:
            providerAccountStatus === 'updated' && providerAccount
              ? `@${providerAccount.login} was already connected.`
              : providerAccount
                ? `Linked @${providerAccount.login}.`
                : 'GitHub is connected.',
        }
      );
      onSuccess();
    } finally {
      setOauthLoading(false);
    }
  };

  const refreshCliAuth = async () => {
    setError(null);
    setCliLoading(true);
    try {
      const result = await importCliAccountsMutation.mutateAsync();
      if (!result.success) {
        setError({
          method: 'cli',
          message: result.error,
        });
        return;
      }

      if (result.importedAccountIds.length === 0) {
        setError({
          method: 'cli',
          message: 'No GitHub CLI session found. Run gh auth login first.',
        });
        return;
      }

      toast('GitHub CLI accounts imported', {
        description:
          result.importedAccountIds.length === 1
            ? `1 account is available in ${PRODUCT_NAME}.`
            : `${result.importedAccountIds.length} accounts are available in ${PRODUCT_NAME}.`,
      });
      onSuccess();
    } finally {
      setCliLoading(false);
    }
  };

  const connectDeviceFlow = () => {
    setError(null);
    // Completing this modal when the device flow succeeds resumes whatever the
    // connect flow interrupted (spec: github-git-settings §5): a modal that
    // launched connect from its identity strip stays open underneath the stack
    // and becomes topmost again. A dismissed device flow keeps this modal open
    // so the user can retry another method.
    const deviceFlowOutcome = openDeviceFlow({});
    void deviceFlowMutation.mutateAsync();
    void deviceFlowOutcome.then((outcome) => {
      if (outcome.success) onSuccess();
    });
  };

  return (
    <>
      <Dialog.Body className="gap-1">
        <p className="mb-3 text-sm text-foreground-muted">Choose how Maestro signs in to GitHub.</p>
        {hasMethod('oauth') ? (
          <ConnectMethodCard
            icon={Github}
            title={oauthContent.title}
            description={oauthContent.description}
            label={oauthContent.buttonLabel}
            loadingLabel={oauthContent.loadingLabel}
            loading={oauthLoading}
            disabled={anyLoading}
            onClick={() => void connectOAuth()}
            error={error?.method === 'oauth' ? error.message : undefined}
          />
        ) : null}

        {hasMethod('cli-import') ? (
          <ConnectMethodCard
            icon={Terminal}
            title="Import from GitHub CLI"
            description="Use accounts already authenticated with GitHub CLI"
            label="Import from GitHub CLI"
            loadingLabel="Checking GitHub CLI accounts"
            loading={cliLoading}
            disabled={anyLoading}
            onClick={() => void refreshCliAuth()}
            error={error?.method === 'cli' ? error.message : undefined}
          />
        ) : null}

        {showDeviceFlowMethod && (
          <ConnectMethodCard
            icon={KeyRound}
            title="Use device flow"
            description="Connect GitHub on this device with a one-time code"
            label="Use device flow"
            loadingLabel="Opening device flow"
            loading={deviceFlowLoading}
            disabled={anyLoading}
            onClick={connectDeviceFlow}
            error={error?.method === 'device_flow' ? error.message : undefined}
          />
        )}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={anyLoading}>
          Cancel
        </Button>
      </Dialog.Footer>
    </>
  );
}

function ConnectMethodCard({
  icon: Icon,
  title,
  description,
  label,
  loadingLabel,
  loading,
  disabled,
  onClick,
  error,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  label: string;
  loadingLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  error?: string;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={loading ? loadingLabel : label}
        className={cn(
          'group/method -mx-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors outline-none',
          'hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'
        )}
      >
        <Icon className="size-4 shrink-0 text-foreground-passive" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs text-foreground-muted">{description}</span>
        </span>
        {loading ? (
          <Spinner size="sm" className="shrink-0 text-foreground-passive" />
        ) : (
          <ChevronRight
            className="size-4 shrink-0 text-foreground-passive transition-[color,transform] group-hover/method:translate-x-0.5 group-hover/method:text-foreground-muted motion-reduce:transform-none"
            aria-hidden
          />
        )}
      </button>
      {error && <InlineError message={error} className="mb-2 ml-7" />}
    </div>
  );
}

function getOAuthContent({ isSignedIn, hasAccount }: { isSignedIn: boolean; hasAccount: boolean }) {
  if (isSignedIn) {
    return {
      title: 'Link GitHub account',
      description: 'Add another GitHub account to your Emdash account',
      buttonLabel: 'Link',
      loadingLabel: 'Linking...',
    };
  }

  if (hasAccount) {
    return {
      title: 'Sign in with GitHub',
      description: 'Sign into your Emdash account',
      buttonLabel: 'Sign In',
      loadingLabel: 'Signing in...',
    };
  }

  return {
    title: 'Sign in to Emdash',
    description: 'Create or sign into your Emdash account with GitHub',
    buttonLabel: 'Continue',
    loadingLabel: 'Continuing...',
  };
}

function InlineError({ message, className }: { message: string; className?: string }) {
  return (
    <p
      role="alert"
      className={cn('flex items-start gap-2 text-xs text-foreground-muted', className)}
    >
      <StateGlyph state="error" size="sm" className="mt-0.5" />
      <span>{message}</span>
    </p>
  );
}
