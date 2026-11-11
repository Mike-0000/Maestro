import { SettingsCard } from '@emdash/ui/react/patterns';
import { Button, SectionLabel, toast, Tooltip } from '@emdash/ui/react/primitives';
import { RotateCcw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { SCOPE_CATALOG } from '@core/manifests/browser/scope-catalog';
import { COMMAND_CATALOG } from '@core/manifests/shared/command-catalog';
import {
  CODE_TO_US_CHAR,
  detectPlatformContext,
  findConflicts,
  keybinding,
  type Chord,
  type KeybindingEntry,
} from '@core/primitives/keybindings/api';
import {
  keyboardLayoutService,
  keybindingService,
  useChordRecorder,
} from '@core/primitives/keybindings/browser';
import { Shortcut } from '@core/primitives/keybindings/browser/shortcut';

const groupsByCommandId = new Map<string, string[]>();
for (const scope of SCOPE_CATALOG) {
  for (const command of scope.commands) {
    const groups = groupsByCommandId.get(command.id) ?? [];
    groups.push(scope.id);
    groupsByCommandId.set(command.id, groups);
  }
}

const CONFLICT_ENTRIES: readonly KeybindingEntry[] = COMMAND_CATALOG.defs.flatMap((command) =>
  command.keybinding
    ? [
        {
          id: command.id,
          groups: groupsByCommandId.get(command.id),
          binding: command.keybinding,
        },
      ]
    : []
);

const SYSTEM_HIDE_ENTRY: KeybindingEntry = {
  id: 'system.hide',
  groups: [],
  binding: keybinding.fixed('Mod+H'),
};

const KeyboardSettingsCard: React.FC = observer(function KeyboardSettingsCard() {
  const {
    value: keyboard,
    update,
    isLoading: loading,
    isSaving: saving,
    resetField,
  } = useAppSettingsKey('keyboard');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const groups = keybindingService.settingsEntries();
  const platform = detectPlatformContext();

  const recorder = useChordRecorder({
    onRecord: (candidate: Chord) => {
      const editingEntry = groups
        .flatMap((group) => group.entries)
        .find((entry) => entry.binding.settingsKey === editingKey);
      if (!editingEntry || !editingKey) return;

      const conflicts = findConflicts(
        platform.os === 'mac' ? [...CONFLICT_ENTRIES, SYSTEM_HIDE_ENTRY] : CONFLICT_ENTRIES,
        candidate,
        editingEntry.command.id,
        keyboard ?? {},
        platform,
        keyboardLayoutService.codeToCharMap() ?? CODE_TO_US_CHAR
      );
      const rejected = conflicts.find(
        (conflict) => conflict.severity === 'reserved' || conflict.severity === 'error'
      );
      if (rejected) {
        const conflictingTitle =
          COMMAND_CATALOG.byId(rejected.id)?.title ??
          (rejected.id === SYSTEM_HIDE_ENTRY.id ? 'Hide Maestro' : rejected.id);
        toast.error(
          rejected.severity === 'reserved' ? 'Shortcut is reserved' : 'Shortcut conflict',
          { description: `Conflicts with "${conflictingTitle}". Choose a different shortcut.` }
        );
        setEditingKey(null);
        return;
      }

      update({ [editingKey]: candidate });
      const shadowing = conflicts.find((conflict) => conflict.severity === 'shadowing');
      const label = keyboardLayoutService.displayLabel(candidate, platform).join(' + ');
      toast('Shortcut updated', {
        description: shadowing
          ? `${editingEntry.command.title} is now ${label}. It shadows ${
              COMMAND_CATALOG.byId(shadowing.id)?.title ?? shadowing.id
            } in some contexts.`
          : `${editingEntry.command.title} is now ${label}.`,
      });
      setEditingKey(null);
    },
    onCancel: () => setEditingKey(null),
  });

  const startCapture = (settingsKey: string) => {
    setEditingKey(settingsKey);
    recorder.startRecording();
  };

  return (
    <SettingsCard>
      <Tooltip.Provider delay={150}>
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.category} className="flex flex-col gap-4">
              <SectionLabel as="h4">{group.category}</SectionLabel>
              {group.entries.map((entry) => {
                const key = entry.binding.settingsKey;
                const capturing = editingKey === key && recorder.isRecording;
                const cleared = keyboard?.[key] === null;
                const showReset = keyboard?.[key] !== undefined;
                const showClear = !cleared;
                return (
                  <div
                    key={entry.command.id}
                    className="group/shortcut flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2"
                  >
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="text-sm wrap-break-word text-foreground">
                        {entry.command.title}
                      </div>
                      {entry.command.description ? (
                        <div className="mt-0.5 text-xs wrap-break-word text-foreground-muted">
                          {entry.command.description}
                        </div>
                      ) : null}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      {capturing ? (
                        <>
                          <span
                            role="status"
                            className="flex h-7 min-w-20 items-center justify-center rounded-md px-2.5 text-xs text-foreground ring-1 ring-ring"
                          >
                            Press keys…
                          </span>
                          <Button
                            type="button"
                            variant="text"
                            size="xs"
                            className="ml-2"
                            onClick={recorder.cancelRecording}
                            disabled={saving}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          {(showClear || showReset) && (
                            <div className="pointer-events-none flex items-center opacity-0 transition-opacity group-focus-within/shortcut:pointer-events-auto group-focus-within/shortcut:opacity-100 group-hover/shortcut:pointer-events-auto group-hover/shortcut:opacity-100">
                              {showReset && (
                                <Tooltip.Root>
                                  <Tooltip.Trigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        icon
                                        onClick={() => {
                                          resetField(key);
                                          toast('Shortcut reset', {
                                            description: `${entry.command.title} reset to default.`,
                                          });
                                        }}
                                        disabled={loading || saving}
                                        aria-label="Reset to default"
                                      >
                                        <RotateCcw className="size-3.5" />
                                      </Button>
                                    }
                                  />
                                  <Tooltip.Content side="top">Reset to default</Tooltip.Content>
                                </Tooltip.Root>
                              )}
                              {showClear && (
                                <Tooltip.Root>
                                  <Tooltip.Trigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        icon
                                        onClick={() => {
                                          update({ [key]: null });
                                          toast('Shortcut removed', {
                                            description: `${entry.command.title} no longer has a key binding.`,
                                          });
                                        }}
                                        disabled={loading || saving}
                                        aria-label="Remove shortcut"
                                      >
                                        <X className="size-3.5" />
                                      </Button>
                                    }
                                  />
                                  <Tooltip.Content side="top">Remove shortcut</Tooltip.Content>
                                </Tooltip.Root>
                              )}
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-w-20 justify-end px-1.5"
                            onClick={() => startCapture(key)}
                            disabled={loading || saving}
                            aria-label={`Change shortcut for ${entry.command.title}`}
                          >
                            {entry.chord ? (
                              <Shortcut hotkey={entry.chord} variant="keycaps" />
                            ) : (
                              <span className="text-xs text-foreground-passive">Not set</span>
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </Tooltip.Provider>
    </SettingsCard>
  );
});

export default KeyboardSettingsCard;
