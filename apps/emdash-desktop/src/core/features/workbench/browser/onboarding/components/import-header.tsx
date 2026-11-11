import type {
  LegacyImportSource,
  LegacyPortPreviewSource,
} from '@core/primitives/legacy-port/api/legacy-port';
import { formatCount } from './import-format';
import { OnboardingStepHeading } from './step-heading';

export type SingleSourceImport = {
  source: LegacyImportSource;
  preview: LegacyPortPreviewSource;
};

export type ImportHeaderProps = {
  isLoading: boolean;
  singleSource?: SingleSourceImport | null;
};

function singleSourceDescription(preview: LegacyPortPreviewSource): string {
  return `Found ${formatCount(preview.projects, 'project')} and ${formatCount(
    preview.tasks,
    'task'
  )} from an earlier version on this computer.`;
}

export function ImportHeader({ isLoading, singleSource = null }: ImportHeaderProps) {
  const description = isLoading
    ? 'Looking for data from an earlier version…'
    : singleSource
      ? singleSourceDescription(singleSource.preview)
      : 'Found data from two earlier versions. Choose what to bring over.';

  return <OnboardingStepHeading title="Bring your projects over" description={description} />;
}
