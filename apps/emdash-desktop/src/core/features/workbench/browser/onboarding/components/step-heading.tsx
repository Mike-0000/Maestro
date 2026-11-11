import type { ReactNode } from 'react';

/** The hero line and one sentence every onboarding step opens with (design brief 2.12). */
export function OnboardingStepHeading({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <h1 className="text-2xl font-medium text-balance text-foreground">{title}</h1>
      {description != null && (
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-balance text-foreground-muted">
          {description}
        </p>
      )}
    </div>
  );
}

/** A plain-words error near the move: the error dot, then the message. */
export function OnboardingError({ children }: { children: ReactNode }) {
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
