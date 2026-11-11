import { StateGlyph } from '@emdash/ui/react/components';
import { MetaLine } from '@emdash/ui/react/patterns';
import { AbsoluteTime } from '@emdash/ui/react/primitives';
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTriggerKind,
} from '@core/features/automations/api/automation-run';
import { formatRunTriggerKindLabel } from '../automation-run-format';
import { runStatusPresentation, RunStatusWords } from './RunStatusBadge';

export interface RunMetaLineProps {
  displayTime: number | null;
  triggerKind: AutomationRunTriggerKind | null;
  runStatus: AutomationRunStatus | null;
  error: AutomationRun['error'];
}

/**
 * The caption under a run: its state (glyph and words), when it ran, and what started it, in
 * the caption role ("Agent started · Nov 11, 09:00 · Triggered by schedule").
 */
export function RunMetaLine({ displayTime, triggerKind, runStatus, error }: RunMetaLineProps) {
  const presentation = runStatusPresentation(runStatus);
  const triggerLabel = triggerKind ? formatRunTriggerKindLabel(triggerKind) : null;

  return (
    <MetaLine
      glyph={presentation ? <StateGlyph state={presentation.glyph} size="sm" /> : undefined}
      start={[
        presentation ? <RunStatusWords key="status" status={runStatus} error={error} /> : null,
        displayTime ? <AbsoluteTime key="time" value={displayTime} /> : 'Not started',
        triggerLabel,
      ]}
    />
  );
}
