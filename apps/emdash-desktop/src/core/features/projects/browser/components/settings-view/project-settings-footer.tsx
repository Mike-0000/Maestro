import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { Check, Loader2, Undo2 } from 'lucide-react';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';

export type ProjectSettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface ProjectSettingsFooterProps {
  dirty: boolean;
  saveStatus: ProjectSettingsSaveStatus;
  canShareConfig: boolean;
  shareDisabled: boolean;
  hostActionReason: string | null;
  onShare: () => void;
  onUndo: () => void;
  onSave: () => void;
}

export function ProjectSettingsFooter({
  dirty,
  saveStatus,
  canShareConfig,
  shareDisabled,
  hostActionReason,
  onShare,
  onUndo,
  onSave,
}: ProjectSettingsFooterProps) {
  const saving = saveStatus === 'saving';
  const saved = saveStatus === 'saved' && !dirty;
  const saveDisabled = saving || !dirty;

  return (
    // Pinned to the bottom of the scrolling settings on the page surface; no rule above it.
    <div className="sticky bottom-0 z-10 flex items-center gap-2 bg-background px-0.5 py-3">
      <Tooltip.Provider delay={150}>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                variant="text"
                className="shrink-0"
                disabled={shareDisabled}
                hidden={!canShareConfig && !hostActionReason}
                aria-disabled={hostActionReason !== null}
                aria-description={hostActionReason ?? undefined}
                onClick={() => {
                  if (!hostActionReason) onShare();
                }}
              >
                Share with team
              </Button>
            }
          />
          <Tooltip.Content side="bottom" align="end">
            {hostActionReason ??
              'Writes selected settings to .emdash.json. Commit that file to share these defaults with your team.'}
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="ghost"
          icon
          aria-label="Reset changes"
          title="Reset changes"
          onClick={onUndo}
          disabled={!dirty || saving}
        >
          <Undo2 />
        </Button>
        <ConfirmButton variant="primary" onClick={onSave} disabled={saveDisabled}>
          <span className="inline-flex min-w-22 items-center justify-center gap-1.5">
            {saving && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            {!saving && saved && <Check className="size-4" aria-hidden="true" />}
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}
          </span>
        </ConfirmButton>
      </div>
    </div>
  );
}
