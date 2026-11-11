import { AbsoluteTime } from '@emdash/ui/react/primitives';
import { useScheduledAutomationRun } from '../use-automations';

interface NextRunBannerProps {
  automationId: string;
  projectId: string | null | undefined;
  runtimeAvailable?: boolean;
}

/** When the automation runs next, as one fact in the caption role. Nothing when none is due. */
export function NextRunBanner({ automationId, projectId, runtimeAvailable }: NextRunBannerProps) {
  const { data } = useScheduledAutomationRun(projectId!, automationId, runtimeAvailable);
  const scheduledAt = data?.scheduledAt ?? null;

  if (!scheduledAt) return null;

  return (
    <span className="text-foreground-muted">
      Next run <AbsoluteTime value={scheduledAt} className="tabular-nums" />
    </span>
  );
}
