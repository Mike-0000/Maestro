import { normalizeExclusionPatterns } from '@emdash/core/primitives/exclusion-policy/api';
import { SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Input, Switch, Textarea, toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useState } from 'react';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { getMachinesStore } from '../../contributions/app-stores';
import { useHostSettings } from '../use-host-settings';

/**
 * Per-host defaults (host-settings runtime): shellSetup, worktree root, tmux, and
 * watcher exclusions, plus the desktop-side "Sync local settings" toggle for
 * remote machines. Text fields commit on blur; switches commit immediately.
 * External edits to the host's settings file stream in through the live model
 * while a field is not focused.
 */
export const HostSettingsCard = observer(function HostSettingsCard({
  machineId,
  enabled = true,
}: {
  machineId?: string;
  enabled?: boolean;
}) {
  const { settings, parseError, isLoading, update } = useHostSettings(machineId, enabled);
  const machinesStore = getMachinesStore();
  const machine = machineId
    ? machinesStore.connections.find((connection) => connection.id === machineId)
    : undefined;
  const syncLocalSettings = machine?.syncLocalSettings ?? false;
  const tmuxSupported = machineId !== undefined || detectPlatformContext().os !== 'windows';
  const [shellSetup, setShellSetup] = useState('');
  const [worktreeRoot, setWorktreeRoot] = useState('');
  const [watcherExclude, setWatcherExclude] = useState('');
  const [editing, setEditing] = useState<'shellSetup' | 'worktreeRoot' | 'watcherExclude' | null>(
    null
  );
  const fieldId = useId();
  const shellSetupId = `${fieldId}-shell-setup`;
  const worktreeRootId = `${fieldId}-worktree-root`;
  const tmuxId = `${fieldId}-tmux`;
  const syncId = `${fieldId}-sync`;
  const watcherId = `${fieldId}-watcher`;

  const watcherExcludeStored = settings?.watcherExclude?.join('\n') ?? '';
  useEffect(() => {
    if (editing !== 'shellSetup') setShellSetup(settings?.shellSetup ?? '');
  }, [settings?.shellSetup, editing]);
  useEffect(() => {
    if (editing !== 'worktreeRoot') setWorktreeRoot(settings?.worktreeRoot ?? '');
  }, [settings?.worktreeRoot, editing]);
  useEffect(() => {
    if (editing !== 'watcherExclude') setWatcherExclude(watcherExcludeStored);
  }, [watcherExcludeStored, editing]);

  const commit = async (patch: Parameters<typeof update>[0]) => {
    try {
      await update(patch);
    } catch (error) {
      toast.error('Failed to save host settings', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const commitText = (field: 'shellSetup' | 'worktreeRoot', value: string) => {
    setEditing(null);
    const trimmed = value.trim();
    if (trimmed === (settings?.[field] ?? '')) return;
    void commit({ [field]: trimmed || null });
  };

  const commitWatcherExclude = (value: string) => {
    setEditing(null);
    const normalized = normalizeExclusionPatterns(value.split(/\r?\n/u));
    if (normalized.join('\n') === watcherExcludeStored) {
      setWatcherExclude(watcherExcludeStored);
      return;
    }
    // Empty clears back to "unset" so the host falls back to the default excludes.
    void commit({ watcherExclude: normalized.length > 0 ? normalized : null });
  };

  const toggleSyncLocalSettings = async (checked: boolean) => {
    if (!machineId) return;
    try {
      await machinesStore.setSyncLocalSettings(machineId, checked);
    } catch (error) {
      toast.error('Failed to update sync setting', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const disabled = isLoading || settings === undefined;

  return (
    <SettingsSection
      title="Host defaults"
      description="Defaults for workspaces on this host, kept in its data folder. Edits made to that file show up here live."
    >
      {parseError ? (
        <p role="alert" className="flex items-start gap-2 text-xs text-foreground-error">
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground-error" />
          The host settings file could not be read, so the defaults apply until it is fixed.
        </p>
      ) : null}

      <SettingsRow
        layout="stacked"
        htmlFor={shellSetupId}
        label="Shell setup"
        description={
          <>
            Commands run before every lifecycle script and terminal session on this host (nvm, mise,
            …). A workspace&apos;s <code className={CODE}>.emdash.json</code>{' '}
            <code className={CODE}>shellSetup</code> overrides this.
          </>
        }
        control={
          <Textarea
            id={shellSetupId}
            placeholder={'nvm use\nsource .envrc'}
            spellCheck={false}
            className="font-mono text-xs"
            value={shellSetup}
            disabled={disabled}
            onFocus={() => setEditing('shellSetup')}
            onChange={(event) => setShellSetup(event.target.value)}
            onBlur={(event) => commitText('shellSetup', event.target.value)}
          />
        }
      />

      <SettingsRow
        layout="stacked"
        htmlFor={worktreeRootId}
        label="Worktree root"
        description="Where new worktrees are created on this host. A project's settings can choose another folder."
        control={
          <Input
            id={worktreeRootId}
            placeholder="~/emdash/worktrees"
            spellCheck={false}
            value={worktreeRoot}
            disabled={disabled}
            onFocus={() => setEditing('worktreeRoot')}
            onChange={(event) => setWorktreeRoot(event.target.value)}
            onBlur={(event) => commitText('worktreeRoot', event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        }
      />

      <SettingsRow
        htmlFor={tmuxId}
        label="Enable tmux by default"
        description={
          tmuxSupported
            ? 'Run sessions on this host inside tmux. A project can override it.'
            : 'tmux is not available for Windows sessions. Your saved preference is kept.'
        }
        control={
          <Switch
            id={tmuxId}
            checked={tmuxSupported ? (settings?.tmux ?? false) : false}
            disabled={disabled || !tmuxSupported}
            onCheckedChange={(checked) => void commit({ tmux: checked })}
          />
        }
      />

      {machineId ? (
        <>
          <SettingsRow
            htmlFor={syncId}
            label="Sync local settings"
            description="Mirror this computer's local settings (for now, watcher exclusions) to this host. While on, the host follows them; turning it off keeps the last synced values."
            control={
              <Switch
                id={syncId}
                checked={syncLocalSettings}
                disabled={disabled || machine === undefined}
                onCheckedChange={(checked) => void toggleSyncLocalSettings(checked)}
              />
            }
          />

          <SettingsRow
            layout="stacked"
            htmlFor={watcherId}
            label="Watcher exclusions"
            description={
              <>
                {syncLocalSettings
                  ? 'Synced from this computer’s local settings. '
                  : 'Folders the file watcher skips on this host, one pattern per line. Leave it empty for the default exclusions; watching dependency or build folders can use tens of thousands of native watches. '}
                Changes apply the next time the workspace server restarts.
              </>
            }
            control={
              <Textarea
                id={watcherId}
                placeholder="One pattern per line (defaults apply when empty)"
                rows={4}
                spellCheck={false}
                className="font-mono text-xs"
                value={watcherExclude}
                disabled={disabled}
                readOnly={syncLocalSettings}
                onFocus={() => {
                  if (!syncLocalSettings) setEditing('watcherExclude');
                }}
                onChange={(event) => {
                  if (!syncLocalSettings) setWatcherExclude(event.target.value);
                }}
                onBlur={(event) => {
                  if (!syncLocalSettings) commitWatcherExclude(event.target.value);
                }}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
});

const CODE = 'rounded-xs bg-surface-emphasis px-1 font-mono text-tiny text-foreground';
