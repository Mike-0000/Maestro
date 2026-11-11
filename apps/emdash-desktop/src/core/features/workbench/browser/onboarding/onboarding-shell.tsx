import { Fragment, useState } from 'react';
import { ChorusMark } from '@core/primitives/app-identity/browser/chorus-logo';
import { cn } from '@core/primitives/styling/browser/cn';
import { ImportStep } from './import-step';
import { SignInStep } from './sign-in-step';

type OnboardingStep = 'sign-in' | 'import';

const stepConfig: Record<
  OnboardingStep,
  { label: string; component: React.ComponentType<{ onComplete: () => void }> }
> = {
  'sign-in': {
    label: 'Sign in',
    component: SignInStep,
  },
  import: {
    label: 'Import',
    component: ImportStep,
  },
};

/**
 * Where the setup is: the step names in the caption role joined by short rules, the current one
 * at full strength and finished ones muted. Shown only when there is more than one step.
 */
function StepTrail({ steps, activeIndex }: { steps: OnboardingStep[]; activeIndex: number }) {
  return (
    <ol aria-label="Setup steps" className="flex items-center gap-3 text-tiny select-none">
      {steps.map((step, index) => (
        <Fragment key={step}>
          {index > 0 && <li aria-hidden className="h-px w-6 bg-border" />}
          <li
            aria-current={index === activeIndex ? 'step' : undefined}
            className={cn(
              'tabular-nums transition-colors',
              index === activeIndex
                ? 'text-foreground'
                : index < activeIndex
                  ? 'text-foreground-muted'
                  : 'text-foreground-passive'
            )}
          >
            {index + 1}&ensp;{stepConfig[step].label}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/**
 * First-run setup: one centred column on the plain content surface. The app's mark sits at the
 * top, the step trail under it, and each step below brings its own hero line, one sentence and
 * one move. No frame, tabs or boxes: the steps read as one calm page.
 */
export function OnboardingShell({
  steps,
  onComplete,
}: {
  steps: OnboardingStep[];
  onComplete: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeStep = steps[activeIndex];
  const StepComponent = stepConfig[activeStep]?.component;

  const handleStepComplete = () => {
    const nextIndex = activeIndex + 1;
    if (nextIndex >= steps.length) {
      onComplete();
    } else {
      setActiveIndex(nextIndex);
    }
  };

  return (
    <div className="my-auto flex w-full max-w-lg flex-col items-center py-16 [-webkit-app-region:no-drag]">
      <ChorusMark size={40} animated={false} />
      {steps.length > 1 && (
        <div className="mt-6">
          <StepTrail steps={steps} activeIndex={activeIndex} />
        </div>
      )}
      <div
        key={activeStep}
        className="mt-10 flex w-full flex-col items-center motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in"
      >
        <StepComponent onComplete={handleStepComplete} />
      </div>
    </div>
  );
}
