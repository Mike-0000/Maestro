import { Button } from '@emdash/ui/react/primitives';
import { useMemo, useState } from 'react';
import {
  useLegacyPortImport,
  useLegacyPortPreview,
  useLegacyPortStartFresh,
} from '@core/features/legacy-port/api/browser/useLegacyPort';
import type { LegacyImportSource } from '@core/primitives/legacy-port/api/legacy-port';
import { useImportProgress } from '@core/primitives/react-hooks/browser/useImportProgress';
import { cn } from '@core/primitives/styling/browser/cn';
import { ImportHeader } from './components/import-header';
import { ImportProgress } from './components/import-progress';
import { ImportSourceSelector } from './components/import-source-selector';
import { ProjectConflicts } from './components/project-conflicts';
import { OnboardingError } from './components/step-heading';
import {
  availableSources,
  shouldCenterImportContent,
  shouldShowSourceSelector,
  singleAvailableSource,
} from './import-state';

function toggleSourceSelection(
  sources: LegacyImportSource[],
  source: LegacyImportSource
): LegacyImportSource[] {
  if (sources.includes(source)) {
    return sources.filter((candidate) => candidate !== source);
  }
  return [...sources, source];
}

export function ImportStep({ onComplete }: { onComplete: () => void }) {
  const { data: preview, isLoading: previewLoading } = useLegacyPortPreview(true);
  const importMutation = useLegacyPortImport();
  const startFreshMutation = useLegacyPortStartFresh();
  const importProgress = useImportProgress();

  const sourceOptions = useMemo(() => availableSources(preview), [preview]);
  const [selectedSourcesOverride, setSelectedSourcesOverride] = useState<
    LegacyImportSource[] | null
  >(null);
  const [conflictChoiceOverrides, setConflictChoiceOverrides] = useState<
    Record<string, LegacyImportSource>
  >({});
  const [startFreshError, setStartFreshError] = useState<string | null>(null);

  const selectedSources = selectedSourcesOverride ?? sourceOptions;
  const visibleConflicts = useMemo(() => {
    if (!selectedSources.includes('v0') || !selectedSources.includes('v1-beta')) return [];
    return preview?.conflicts ?? [];
  }, [preview?.conflicts, selectedSources]);

  const v0Preview = preview?.sources.v0 ?? { available: false, projects: 0, tasks: 0 };
  const betaPreview = preview?.sources.v1Beta ?? { available: false, projects: 0, tasks: 0 };
  const canImport = selectedSources.length > 0 && !previewLoading;
  const singleSource = singleAvailableSource(preview);
  const showSourceSelector = shouldShowSourceSelector(preview);
  const centerContent = shouldCenterImportContent(preview);

  const toggleSource = (source: LegacyImportSource) => {
    setSelectedSourcesOverride((current) =>
      toggleSourceSelection(current ?? selectedSources, source)
    );
  };

  const updateConflictChoice = (identityKey: string, source: LegacyImportSource) => {
    setConflictChoiceOverrides((current) => ({
      ...current,
      [identityKey]: source,
    }));
  };

  const handleImport = async () => {
    setStartFreshError(null);
    const conflictChoices = Object.fromEntries(
      visibleConflicts.map((conflict) => [
        conflict.identityKey,
        conflictChoiceOverrides[conflict.identityKey] ?? 'v1-beta',
      ])
    ) as Record<string, LegacyImportSource>;

    await importProgress.run(
      () =>
        importMutation.mutateAsync({
          sources: selectedSources,
          conflictChoices,
        }),
      { onComplete }
    );
  };

  const handleStartFresh = async () => {
    setStartFreshError(null);
    importProgress.clearError();
    try {
      const result = await startFreshMutation.mutateAsync();
      if (!result.success) {
        setStartFreshError(result.error ?? 'Start fresh failed');
        return;
      }
      onComplete();
    } catch (err) {
      setStartFreshError(err instanceof Error ? err.message : 'Start fresh failed');
    }
  };

  const isBusy = importProgress.isImporting || startFreshMutation.isPending;

  // One column: the hero line and what was found, the choices (only when there are any), then
  // the one move with "Start fresh" as the quiet way out under it.
  return (
    <div className={cn('flex w-full flex-col items-center gap-8', centerContent && 'pt-4')}>
      <ImportHeader
        isLoading={previewLoading}
        singleSource={
          singleSource
            ? {
                source: singleSource,
                preview: singleSource === 'v0' ? v0Preview : betaPreview,
              }
            : null
        }
      />

      {!previewLoading && showSourceSelector && (
        <ImportSourceSelector
          sources={sourceOptions}
          v0Preview={v0Preview}
          betaPreview={betaPreview}
          selectedSources={selectedSources}
          disabled={importProgress.isImporting}
          onToggle={toggleSource}
        />
      )}

      <ProjectConflicts
        conflicts={visibleConflicts}
        choices={conflictChoiceOverrides}
        disabled={importProgress.isImporting}
        onChoiceChange={updateConflictChoice}
      />

      <div className="flex w-full shrink-0 flex-col items-center gap-4">
        {importProgress.isImporting ? (
          <ImportProgress progress={importProgress.progress} />
        ) : (
          <Button
            variant="primary"
            className="min-w-56"
            onClick={handleImport}
            disabled={isBusy || !canImport}
          >
            Import
          </Button>
        )}
        {importProgress.error && <OnboardingError>{importProgress.error}</OnboardingError>}
        {startFreshError && <OnboardingError>{startFreshError}</OnboardingError>}
        <Button variant="text" className="mt-1" onClick={handleStartFresh} disabled={isBusy}>
          {startFreshMutation.isPending ? 'Starting fresh…' : 'Start fresh instead'}
        </Button>
      </div>
    </div>
  );
}
