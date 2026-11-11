import { Combobox, InputGroup, ToggleGroup, Tooltip } from '@emdash/ui/react/primitives';
import { GitBranch, RefreshCw } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
  filterBranchesForPicker,
  getBranchLabel,
  prioritizeExactBranchMatches,
  type BranchLabelRemoteMode,
} from '@core/features/source-control/api/browser/components/branch-selector-utils';
import { RemoteSelector } from '@core/features/source-control/contributions/browser/remote-selector';
import type { GitBranchRef, GitRemote } from '@core/primitives/git/api';
import { cn } from '@core/primitives/styling/browser/cn';

type BranchSelectorTab = 'local' | 'remote';
export {
  getBranchLabel,
  type BranchLabelRemoteMode,
} from '@core/features/source-control/api/browser/components/branch-selector-utils';

interface BranchSelectorProps {
  branches: GitBranchRef[];
  value?: GitBranchRef;
  onValueChange: (value: GitBranchRef) => void;
  remoteOnly?: boolean;
  branchLabelRemote?: BranchLabelRemoteMode;
  trigger?: React.ReactNode;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  refreshDisabledReason?: string | null;
  observationKind?: 'fresh' | 'stale' | 'unavailable';
  remotes?: GitRemote[];
  selectedRemoteName?: string;
}

export function BranchSelector({
  branches,
  value,
  onValueChange,
  remoteOnly = false,
  branchLabelRemote = 'full',
  trigger,
  onRefresh,
  isRefreshing = false,
  refreshDisabledReason,
  observationKind = 'fresh',
  remotes,
  selectedRemoteName,
}: BranchSelectorProps) {
  const valueKey =
    value?.type === 'remote'
      ? `${value.type}:${value.remote.name}/${value.branch}`
      : `${value?.type ?? 'none'}:${value?.branch ?? ''}`;
  const [tabOverride, setTabOverride] = useState<
    { tab: BranchSelectorTab; valueKey: string } | undefined
  >(undefined);
  const overriddenTab = tabOverride?.valueKey === valueKey ? tabOverride.tab : undefined;
  const tab = remoteOnly ? 'remote' : (overriddenTab ?? value?.type ?? 'local');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const keepOpenForRemoteSelectRef = React.useRef(false);
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [draftRemoteName, setDraftRemoteName] = useState<string | undefined>(undefined);
  const showRemoteFooter = selectedRemoteName !== undefined;
  const activeRemoteName =
    showRemoteFooter && open ? (draftRemoteName ?? selectedRemoteName) : selectedRemoteName;
  // Defined exactly when the footer renders (selectedRemoteName is set).
  const footerRemoteName = activeRemoteName ?? selectedRemoteName;

  const localCount = useMemo(() => branches.filter((b) => b.type === 'local').length, [branches]);
  const remoteCount = useMemo(
    () =>
      branches.filter(
        (b) => b.type === 'remote' && (!showRemoteFooter || b.remote.name === activeRemoteName)
      ).length,
    [activeRemoteName, branches, showRemoteFooter]
  );

  const filteredBranches = useMemo(
    () =>
      prioritizeExactBranchMatches(
        filterBranchesForPicker(branches, tab, showRemoteFooter ? activeRemoteName : undefined),
        inputValue,
        branchLabelRemote
      ),
    [activeRemoteName, branchLabelRemote, branches, inputValue, showRemoteFooter, tab]
  );

  const options = useMemo(
    () =>
      filteredBranches.map((branch) => ({
        value: branch,
        label: getBranchLabel(branch, { remote: branchLabelRemote }),
        disabled: branch.branch.startsWith('_reserve'),
      })),
    [branchLabelRemote, filteredBranches]
  );

  return (
    <Combobox.Root
      open={open}
      inputValue={inputValue}
      onInputValueChange={(nextInputValue: string, { reason }: { reason: string }) => {
        if (reason !== 'item-press') setInputValue(nextInputValue);
      }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && keepOpenForRemoteSelectRef.current) {
          setOpen(true);
          return;
        }
        setOpen(nextOpen);
        if (!nextOpen) setInputValue('');
        setDraftRemoteName(nextOpen ? selectedRemoteName : undefined);
      }}
      items={options}
      autoHighlight
      value={
        value
          ? {
              value,
              label: getBranchLabel(value, { remote: branchLabelRemote }),
            }
          : undefined
      }
      onValueChange={(v) => v !== null && onValueChange(v.value)}
      isItemEqualToValue={(a, b) => {
        if (a.value.type !== b.value.type) return false;
        if (a.value.branch !== b.value.branch) return false;
        if (a.value.type === 'remote' && b.value.type === 'remote') {
          return a.value.remote.name === b.value.remote.name;
        }
        return true;
      }}
    >
      {trigger ?? (
        <Combobox.Trigger className="flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-border px-2.5 text-left text-sm text-foreground transition-colors outline-none hover:border-border-1 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring emlight:border-border-1">
          <span className="flex min-w-0 items-center gap-2">
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-foreground-passive" />
            <span className="min-w-0 truncate">
              <Combobox.Value placeholder="Select a branch" />
            </span>
          </span>
        </Combobox.Trigger>
      )}
      <Combobox.Content
        className={cn('min-w-(--anchor-width)', showRemoteFooter ? 'pb-0' : 'pb-1')}
      >
        {observationKind === 'stale' ? (
          <p role="status" className="px-2.5 pt-1.5 pb-1 text-tiny text-foreground-passive">
            Showing previously observed branches
          </p>
        ) : null}
        {!remoteOnly && (
          <ToggleGroup.Root
            value={[tab]}
            onValueChange={([value]) => {
              if (value) {
                setTabOverride({ tab: value as BranchSelectorTab, valueKey });
                inputRef.current?.focus();
              }
            }}
            className="m-1 flex"
          >
            <ToggleGroup.Item
              value="local"
              className="flex flex-1 items-center gap-1.5"
              disabled={localCount === 0}
            >
              Local
              <span className="text-foreground-passive tabular-nums">{localCount}</span>
            </ToggleGroup.Item>
            <ToggleGroup.Item
              value="remote"
              className="flex flex-1 items-center gap-1.5"
              disabled={remoteCount === 0}
            >
              Remote
              <span className="text-foreground-passive tabular-nums">{remoteCount}</span>
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
        <Combobox.Input
          showTrigger={false}
          placeholder="Search branches"
          inputRef={inputRef}
          rightAddon={
            onRefresh && (
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <InputGroup.Button
                      className="text-foreground-muted hover:text-foreground"
                      onClick={() => {
                        if (!refreshDisabledReason) onRefresh();
                      }}
                      disabled={isRefreshing}
                      aria-disabled={!!refreshDisabledReason}
                      aria-description={refreshDisabledReason ?? undefined}
                      aria-label="Refresh branches"
                    >
                      <RefreshCw
                        className={cn('size-3.5', isRefreshing && 'motion-safe:animate-spin')}
                      />
                    </InputGroup.Button>
                  }
                />
                <Tooltip.Content>{refreshDisabledReason ?? 'Refresh branches'}</Tooltip.Content>
              </Tooltip.Root>
            )
          }
        />
        <Combobox.List>
          {(item) => (
            <Combobox.Item value={item} disabled={item.disabled}>
              {item.label}
            </Combobox.Item>
          )}
        </Combobox.List>
        <Combobox.Empty>
          {observationKind === 'unavailable'
            ? 'Branches unavailable'
            : branches.length === 0
              ? 'No branches yet'
              : 'No matching branches'}
        </Combobox.Empty>
        {footerRemoteName !== undefined && (
          <div className="mt-1 border-t border-border-subtle">
            <RemoteSelector
              remotes={remotes ?? []}
              value={footerRemoteName}
              onOpenChange={(nextOpen) => {
                keepOpenForRemoteSelectRef.current = true;
                if (nextOpen) {
                  setOpen(true);
                } else {
                  requestAnimationFrame(() => {
                    keepOpenForRemoteSelectRef.current = false;
                  });
                }
              }}
              onValueChange={(remoteName) => {
                keepOpenForRemoteSelectRef.current = true;
                setDraftRemoteName(remoteName);
                setTabOverride({ tab: 'remote', valueKey });
                setOpen(true);
                requestAnimationFrame(() => {
                  setOpen(true);
                  inputRef.current?.focus();
                  keepOpenForRemoteSelectRef.current = false;
                });
              }}
              appearance="control"
              className="h-8 w-full rounded-none border-0 bg-transparent px-3 text-sm shadow-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
              renderTrigger={(selected) => (
                <span className="min-w-0 flex-1 truncate text-left text-foreground-muted">
                  {selected?.label ?? activeRemoteName}
                </span>
              )}
            />
          </div>
        )}
      </Combobox.Content>
    </Combobox.Root>
  );
}
