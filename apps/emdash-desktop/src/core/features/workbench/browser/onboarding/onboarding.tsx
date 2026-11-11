import { useState } from 'react';
import { OnboardingShell } from './onboarding-shell';

type OnboardingStep = 'sign-in' | 'import';

export function Onboarding({
  steps: initialSteps,
  onComplete,
}: {
  steps: OnboardingStep[];
  onComplete: () => void;
}) {
  const [steps] = useState(initialSteps);

  // The whole window is the plain content surface and stays draggable around the column; the
  // shell itself opts out so its controls take clicks.
  return (
    <div className="flex h-full w-full flex-col items-center overflow-y-auto bg-background px-6 [-webkit-app-region:drag]">
      <OnboardingShell steps={steps} onComplete={onComplete} />
    </div>
  );
}
