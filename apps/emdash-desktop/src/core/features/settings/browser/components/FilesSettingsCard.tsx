import { normalizeExclusionPatterns } from '@emdash/core/primitives/exclusion-policy/api';
import { Textarea } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { FilesSettings } from '@core/primitives/app-settings/api';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

type ExclusionField = keyof FilesSettings;

type ExclusionListEditorProps = {
  title: string;
  description: string;
  field: ExclusionField;
  value: readonly string[];
  loading: boolean;
  saving: boolean;
  overridden: boolean;
  onCommit(field: ExclusionField, value: string[]): void;
  onReset(field: ExclusionField): void;
};

const FilesSettingsCard: React.FC = () => {
  const {
    value: files,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('files');

  const current: FilesSettings = files ?? {
    treeExclude: [],
    searchExclude: [],
    watcherExclude: [],
  };

  const commitField = (field: ExclusionField, value: string[]) => {
    update({ [field]: normalizeExclusionPatterns(value) });
  };

  return (
    <>
      <ExclusionListEditor
        title="File tree exclusions"
        description="Hidden from the editor's file tree."
        field="treeExclude"
        value={current.treeExclude}
        loading={loading}
        saving={saving}
        overridden={isFieldOverridden('treeExclude')}
        onCommit={commitField}
        onReset={resetField}
      />
      <ExclusionListEditor
        title="Search exclusions"
        description="Left out of file and content search."
        field="searchExclude"
        value={current.searchExclude}
        loading={loading}
        saving={saving}
        overridden={isFieldOverridden('searchExclude')}
        onCommit={commitField}
        onReset={resetField}
      />
      <ExclusionListEditor
        title="Watcher exclusions"
        description="Folders the file watcher skips for the editor, Git status and workspace tracking. Watching dependency or build folders can use tens of thousands of native watches. Applies after a restart."
        field="watcherExclude"
        value={current.watcherExclude}
        loading={loading}
        saving={saving}
        overridden={isFieldOverridden('watcherExclude')}
        onCommit={commitField}
        onReset={resetField}
      />
    </>
  );
};

function ExclusionListEditor({
  title,
  description,
  field,
  value,
  loading,
  saving,
  overridden,
  onCommit,
  onReset,
}: ExclusionListEditorProps): React.JSX.Element {
  const inputId = React.useId();
  const serialized = value.join('\n');
  const [draft, setDraft] = React.useState(serialized);

  React.useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  const commit = () => {
    const patterns = draft.split(/\r?\n/u);
    const normalized = normalizeExclusionPatterns(patterns);
    if (normalized.join('\n') !== serialized) onCommit(field, normalized);
    else setDraft(serialized);
  };

  return (
    <SettingRow
      layout="stacked"
      title={title}
      description={description}
      htmlFor={inputId}
      control={
        <div className="flex w-full min-w-0 items-start gap-1">
          <Textarea
            id={inputId}
            value={draft}
            placeholder="One pattern per line"
            rows={3}
            disabled={loading || saving}
            spellCheck={false}
            className="field-sizing-content max-h-60 min-h-20 flex-1 font-mono text-xs"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
          />
          <ResetToDefaultButton
            visible={overridden}
            defaultLabel="defaults"
            onReset={() => onReset(field)}
            disabled={loading || saving}
          />
        </div>
      }
    />
  );
}

export default FilesSettingsCard;
