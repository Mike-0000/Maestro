import type { TerminalShellId } from '@emdash/core/primitives/terminal-shell/api';
import {
  Button,
  Combobox,
  Select,
  Spinner,
  Switch,
  TriggerButton,
} from '@emdash/ui/react/primitives';
import { Minus, Plus } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { useInstalledFonts } from '@core/features/settings/browser/use-installed-fonts';
import {
  buildTerminalFontFamily,
  defaultTerminalFontName,
} from '@core/features/terminals/api/browser/pty/terminal-font';
import {
  DEFAULT_TERMINAL_SHELL_AVAILABILITY,
  useTerminalShellAvailability,
} from '@core/features/terminals/api/browser/use-terminal-shell-availability';
import { TerminalShellOptionLabel } from '@core/features/terminals/contributions/browser/terminal-shell-option-label';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '@core/primitives/terminals/api';
import { SettingRow } from './SettingRow';

type FontOption = {
  value: string;
  label: string;
};

type FontGroup = {
  value: 'popular' | 'installed';
  label: string;
  items: FontOption[];
};

const POPULAR_FONTS = [
  'Menlo',
  'SF Mono',
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Iosevka',
  'Source Code Pro',
  'MesloLGS NF',
];

const platformOs = detectPlatformContext().os;

// The face the default family chain lands on here (Menlo on macOS, Consolas on Windows).
const DEFAULT_OPTION: FontOption = {
  value: '',
  label: `Default (${defaultTerminalFontName(platformOs)})`,
};

const clampFontSize = (size: number) =>
  Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));

const isMac = platformOs === 'mac';

const TerminalSettingsCard: React.FC = () => {
  const {
    value: terminal,
    update,
    isLoading: loading,
    isSaving: saving,
  } = useAppSettingsKey('terminal');
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const { fonts: installedFonts, isLoading: loadingFonts } = useInstalledFonts();
  const { data: localShellAvailability = DEFAULT_TERMINAL_SHELL_AVAILABILITY } =
    useTerminalShellAvailability(undefined);

  const fontFamily = terminal?.fontFamily ?? '';
  const fontSize = terminal?.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT;
  const autoCopyOnSelection = terminal?.autoCopyOnSelection ?? false;
  const macOptionIsMeta = terminal?.macOptionIsMeta ?? false;
  const defaultShell = terminal?.defaultShell ?? 'system';
  const selectedShell = useMemo(
    () =>
      localShellAvailability.find((entry) => entry.id === defaultShell) ?? {
        id: defaultShell,
        label: defaultShell === 'system' ? 'Loading...' : defaultShell,
        isSystemDefault: false,
        available: true,
      },
    [defaultShell, localShellAvailability]
  );

  const groups = useMemo<FontGroup[]>(() => {
    const popularSet = new Set(POPULAR_FONTS.map((f) => f.toLowerCase()));

    const installedSet = new Set(installedFonts.map((font) => font.toLowerCase()));
    const popularItems: FontOption[] = [DEFAULT_OPTION];
    for (const font of POPULAR_FONTS) {
      if (installedSet.has(font.toLowerCase())) {
        popularItems.push({ value: font, label: font });
      }
    }

    const installedItems: FontOption[] = [];
    for (const font of installedFonts) {
      const lower = font.toLowerCase();
      if (popularSet.has(lower)) continue;
      installedItems.push({ value: font, label: font });
    }

    return [
      { value: 'popular', label: 'Popular', items: popularItems },
      { value: 'installed', label: 'Installed', items: installedItems },
    ];
  }, [installedFonts]);

  const visibleGroups = useMemo<FontGroup[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups.filter((group) => group.items.length > 0);
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.toLowerCase().includes(q)),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  const selectedOption = useMemo<FontOption | null>(() => {
    if (!fontFamily) return DEFAULT_OPTION;
    for (const group of groups) {
      const match = group.items.find((o) => o.value.toLowerCase() === fontFamily.toLowerCase());
      if (match) return match;
    }
    return { value: fontFamily, label: fontFamily };
  }, [fontFamily, groups]);

  const applyFont = useCallback(
    (next: string) => {
      const normalized = next.trim();
      update({ fontFamily: normalized });
      window.dispatchEvent(
        new CustomEvent('terminal-font-changed', { detail: { fontFamily: normalized } })
      );
    },
    [update]
  );

  const applyFontSize = useCallback(
    (next: number) => {
      const normalized = clampFontSize(next);
      update({ fontSize: normalized });
      window.dispatchEvent(
        new CustomEvent('terminal-font-changed', { detail: { fontSize: normalized } })
      );
    },
    [update]
  );

  const toggleAutoCopy = useCallback(
    (next: boolean) => {
      update({ autoCopyOnSelection: next });
      window.dispatchEvent(
        new CustomEvent('terminal-auto-copy-changed', { detail: { autoCopyOnSelection: next } })
      );
    },
    [update]
  );

  const toggleMacOptionIsMeta = useCallback(
    (next: boolean) => {
      update({ macOptionIsMeta: next });
      window.dispatchEvent(
        new CustomEvent('terminal-mac-option-is-meta-changed', {
          detail: { macOptionIsMeta: next },
        })
      );
    },
    [update]
  );

  const applyDefaultShell = useCallback(
    (next: TerminalShellId) => {
      update({ defaultShell: next });
    },
    [update]
  );

  return (
    <>
      <SettingRow
        title="Default terminal shell"
        description="Used for new local terminals. Remote terminals use the remote system shell."
        control={
          <Select.Root
            value={defaultShell}
            onValueChange={(next) => applyDefaultShell(next as TerminalShellId)}
            disabled={loading || saving}
          >
            <Select.Trigger appearance="input" className="w-56" aria-label="Default terminal shell">
              <Select.Value>
                <TerminalShellOptionLabel entry={selectedShell} showSystemBadge={false} />
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="end" width="content-at-least-trigger">
              {localShellAvailability.map((entry) => (
                <Select.Item
                  key={entry.id}
                  value={entry.id}
                  disabled={!entry.available}
                  title={entry.reason}
                >
                  <TerminalShellOptionLabel entry={entry} />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        }
      />
      <SettingRow
        title="Terminal font"
        description="Choose the font family for the terminal."
        control={
          <div className="w-56 shrink-0">
            <Combobox.Root
              items={visibleGroups}
              value={selectedOption}
              onValueChange={(opt: FontOption | null) => {
                if (opt) applyFont(opt.value);
              }}
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open);
                if (!open) setQuery('');
              }}
              inputValue={query}
              onInputValueChange={(val: string, { reason }: { reason: string }) => {
                if (reason !== 'item-press') setQuery(val);
              }}
              isItemEqualToValue={(a: FontOption, b: FontOption) => a.value === b.value}
              filter={null}
              autoHighlight
            >
              <Combobox.Trigger
                render={
                  <TriggerButton
                    appearance="input"
                    disabled={loading || saving}
                    aria-label="Terminal font"
                    className="w-full"
                  />
                }
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  <Combobox.Value placeholder={DEFAULT_OPTION.label} />
                </span>
              </Combobox.Trigger>
              <Combobox.Content>
                <Combobox.Input
                  showTrigger={false}
                  placeholder="Search custom font"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const typed = e.currentTarget.value.trim();
                    if (!typed) return;
                    e.preventDefault();
                    applyFont(typed);
                    setPickerOpen(false);
                  }}
                />
                <Combobox.List>
                  {(group: FontGroup) => (
                    <Combobox.Group key={group.value} items={group.items}>
                      <Combobox.Label>{group.label}</Combobox.Label>
                      <Combobox.Collection>
                        {(item: FontOption) => (
                          <Combobox.Item key={item.value || '__default__'} value={item}>
                            <span
                              style={{
                                fontFamily: item.value
                                  ? `"${item.value}"`
                                  : buildTerminalFontFamily(),
                              }}
                            >
                              {item.label}
                            </span>
                          </Combobox.Item>
                        )}
                      </Combobox.Collection>
                    </Combobox.Group>
                  )}
                </Combobox.List>
                {loadingFonts ? (
                  <div className="flex h-8 items-center gap-2 px-3 text-sm text-foreground-muted">
                    <Spinner size="sm" className="text-foreground-passive" />
                    <span className="truncate">Loading installed fonts…</span>
                  </div>
                ) : null}
                <Combobox.Empty>No fonts found.</Combobox.Empty>
              </Combobox.Content>
            </Combobox.Root>
          </div>
        }
      />
      <SettingRow
        title="Terminal font size"
        description="Adjust the font size used by terminal sessions and CLI agents."
        control={
          <div
            role="group"
            aria-label="Terminal font size"
            className="flex h-8 w-56 shrink-0 items-center justify-between rounded-md border border-border bg-(--em-surface-input) px-1 emlight:border-border-1"
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon
              disabled={loading || saving || fontSize <= TERMINAL_FONT_SIZE_MIN}
              onClick={() => applyFontSize(fontSize - 1)}
              aria-label="Decrease terminal font size"
            >
              <Minus />
            </Button>
            <div className="flex min-w-14 items-baseline justify-center gap-1 text-sm text-foreground tabular-nums">
              <span>{fontSize}</span>
              <span className="text-xs text-foreground-passive">px</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon
              disabled={loading || saving || fontSize >= TERMINAL_FONT_SIZE_MAX}
              onClick={() => applyFontSize(fontSize + 1)}
              aria-label="Increase terminal font size"
            >
              <Plus />
            </Button>
          </div>
        }
      />
      <SettingRow
        title="Auto-copy selected text"
        description="Automatically copy text to clipboard when you select it in the terminal."
        control={
          <Switch
            checked={autoCopyOnSelection}
            disabled={loading || saving}
            onCheckedChange={toggleAutoCopy}
            aria-label="Auto-copy selected text"
          />
        }
      />
      {isMac ? (
        <SettingRow
          title="Use Option as Meta key"
          description="Treat the Option key as the Meta key in the terminal."
          control={
            <Switch
              checked={macOptionIsMeta}
              disabled={loading || saving}
              onCheckedChange={toggleMacOptionIsMeta}
              aria-label="Use Option as Meta key"
            />
          }
        />
      ) : null}
    </>
  );
};

export default TerminalSettingsCard;
