import { Button, Spinner, useToast } from '@emdash/ui/react/primitives';
import { User } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  useAccountHealth,
  useAccountSession,
  useAccountSignIn,
  useAccountSignOut,
} from '@core/features/account/api/browser/useAccount';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { ServerUnavailableMessage } from './ServerUnavailableMessage';
import { SettingRow } from './SettingRow';

/**
 * The Emdash account row of the General page (the upstream account service that connects
 * GitHub with OAuth). One row in every state: who is signed in, or what to do next.
 */
export function AccountTab() {
  const { data: session, isLoading } = useAccountSession();
  const { data: serverAvailable } = useAccountHealth();
  const signInMutation = useAccountSignIn();
  const signOutMutation = useAccountSignOut();
  const { toast } = useToast();
  const openConfirmSignOut = useOpenModal('confirmActionModal');
  const [error, setError] = useState<string | null>(null);

  const user = session?.user ?? null;
  const isSignedIn = session?.isSignedIn ?? false;
  const hasAccount = session?.hasAccount ?? false;
  const displayName = user?.name?.trim() || user?.username || '';

  const handleSignIn = async () => {
    setError(null);
    try {
      const result = await signInMutation.mutateAsync(undefined);
      if (!result.success) {
        const message = result.error || 'Sign in failed';
        setError(message);
        toast.error('Sign in failed', { description: message });
        return;
      }
      toast('Signed in to Emdash', {
        description: result.user
          ? `Connected as ${result.user.name?.trim() || result.user.username}`
          : 'Signed in',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign in failed';
      setError(message);
      toast.error('Sign in failed', { description: message });
    }
  };

  const performSignOut = async () => {
    try {
      await signOutMutation.mutateAsync();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign out failed';
      toast.error('Sign out failed', { description: message });
    }
  };

  const handleSignOut = () => {
    void openConfirmSignOut({
      title: 'Sign out of Emdash?',
      description: 'You will need to sign in again to reconnect your Emdash account.',
      confirmLabel: 'Sign out',
      variant: 'default',
    }).then((outcome) => {
      if (outcome.success) void performSignOut();
    });
  };

  if (isLoading) {
    return (
      <SettingRow
        title="Emdash account"
        description="Checking your account…"
        control={<Spinner size="sm" className="text-foreground-passive" aria-label="Loading" />}
      />
    );
  }

  if (isSignedIn && user) {
    return (
      <SettingRow
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />
            ) : (
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-hover">
                <User className="size-3.5 text-foreground-passive" aria-hidden />
              </span>
            )}
            <span className="min-w-0 truncate">{displayName}</span>
          </span>
        }
        description={user.email ? `${user.email} · Emdash account` : 'Emdash account'}
        control={
          <Button
            type="button"
            variant="text"
            onClick={handleSignOut}
            disabled={signOutMutation.isPending}
          >
            Sign out
          </Button>
        }
      />
    );
  }

  const expired = hasAccount && !isSignedIn;
  const pending = signInMutation.isPending;
  return (
    <SettingRow
      title="Emdash account"
      description={
        <AccountDescription error={error}>
          {expired
            ? 'Your session expired. Sign in again to reconnect your Emdash account.'
            : 'Create an Emdash account to connect GitHub automatically with OAuth.'}
        </AccountDescription>
      }
      control={
        serverAvailable === false ? (
          <ServerUnavailableMessage />
        ) : (
          <Button
            type="button"
            variant="text"
            onClick={() => void handleSignIn()}
            disabled={pending}
            aria-busy={pending}
          >
            {expired
              ? pending
                ? 'Signing in…'
                : 'Sign in'
              : pending
                ? 'Creating account…'
                : 'Create account'}
          </Button>
        )
      }
    />
  );
}

function AccountDescription({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-foreground-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
