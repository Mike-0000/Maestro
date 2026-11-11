import { Button, Spinner } from '@emdash/ui/react/primitives';
import { Github, User } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAccountSession, useAccountSignIn } from '@core/features/account/api/browser/useAccount';
import { useDelayedBoolean } from '@core/primitives/react-hooks/browser/use-delay-boolean';
import { OnboardingError, OnboardingStepHeading } from './components/step-heading';

export function SignInStep({ onComplete }: { onComplete: () => void }) {
  const { data: session, isLoading: sessionLoading } = useAccountSession();
  const signInMutation = useAccountSignIn();
  const skippedSignInRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // A fast session check never flashes a spinner.
  const showLoading = useDelayedBoolean(sessionLoading, 400);

  const handleSignIn = async () => {
    skippedSignInRef.current = false;
    setError(null);
    try {
      const result = await signInMutation.mutateAsync(undefined);
      if (!result.success) {
        if (skippedSignInRef.current) return;
        setError(result.error || 'Sign in failed');
        return;
      }
      if (skippedSignInRef.current) {
        return;
      }
      onComplete();
    } catch (err) {
      if (skippedSignInRef.current) return;
      setError(err instanceof Error ? err.message : 'Sign in failed');
    }
  };

  const handleSkip = () => {
    skippedSignInRef.current = true;
    onComplete();
  };

  if (sessionLoading) {
    return (
      <div role="status" className="flex min-h-48 flex-col items-center justify-center gap-3">
        {showLoading && (
          <>
            <Spinner className="text-foreground-passive" />
            <span className="text-sm text-foreground-muted">Checking your account…</span>
          </>
        )}
      </div>
    );
  }

  if (session?.isSignedIn && session.user) {
    const { user } = session;
    return (
      <div className="flex w-full flex-col items-center">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="size-12 rounded-full bg-surface-emphasis ring-1 ring-border-subtle"
          />
        ) : (
          <span className="flex size-12 items-center justify-center rounded-full bg-surface-emphasis ring-1 ring-border-subtle">
            <User className="size-5 text-foreground-passive" aria-hidden />
          </span>
        )}
        <div className="mt-6">
          <OnboardingStepHeading
            title={`Connected as @${user.username}`}
            description={user.email ?? 'Your GitHub account is ready to use.'}
          />
        </div>
        <Button variant="primary" className="mt-8 min-w-40" onClick={onComplete}>
          Continue
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center">
      <OnboardingStepHeading
        title="Connect GitHub"
        description="Maestro uses GitHub to clone repositories, open pull requests and read issues. You can also connect it later in Settings."
      />
      <Button
        variant="primary"
        className="mt-8 min-w-56"
        onClick={handleSignIn}
        disabled={signInMutation.isPending}
      >
        {signInMutation.isPending ? <Spinner size="sm" /> : <Github className="size-4" />}
        {signInMutation.isPending ? 'Signing in…' : 'Sign in with GitHub'}
      </Button>
      {error && (
        <div className="mt-4">
          <OnboardingError>{error}</OnboardingError>
        </div>
      )}
      <Button variant="text" className="mt-5" onClick={handleSkip}>
        Skip for now
      </Button>
    </div>
  );
}
