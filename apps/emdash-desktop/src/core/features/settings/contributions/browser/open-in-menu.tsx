import { DropdownMenu, Tooltip, useToast } from '@emdash/ui/react/primitives';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useEffect, useMemo } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { useOpenInApps } from '@core/features/settings/api/browser/useOpenInApps';
import { OpenInAppIcon } from '@core/features/settings/browser/components/OpenInAppIcon';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import {
  isValidOpenInAppId,
  type OpenInAppId,
} from '@core/primitives/open-in-apps/api/open-in-apps';
import { openInCommandRegistry } from '@core/primitives/open-in-apps/browser/open-in-command-registry';
import { cn } from '@core/primitives/styling/browser/cn';

interface OpenInMenuProps {
  path: string;
  className?: string;
  borderless?: boolean;
  isRemote?: boolean;
  sshConnectionId?: string;
}

export const OpenInMenu: React.FC<OpenInMenuProps> = ({
  path,
  className,
  borderless = false,
  isRemote = false,
  sshConnectionId,
}) => {
  const { toast } = useToast();
  const { icons, labels, installedApps, availability, platform, loading } = useOpenInApps();
  const { value: openIn, update } = useAppSettingsKey('openIn');

  const defaultApp: OpenInAppId | null =
    openIn?.default && isValidOpenInAppId(openIn.default) ? openIn.default : null;

  const persistPreferredApp = useCallback(
    (appId: OpenInAppId) => {
      update({ default: appId });
    },
    [update]
  );

  const triggerOpenIn = useCallback(
    async (appId: OpenInAppId) => {
      const label = labels[appId] || appId;
      try {
        const res = await (
          await getHostClient()
        ).openIn({
          app: appId,
          path,
          isRemote,
          sshConnectionId,
        });
        if (!res?.success) {
          toast.error(`Open in ${label} failed`, {
            description: res?.error || 'Application not available.',
          });
        }
      } catch (e: unknown) {
        toast.error(`Open in ${label} failed`, {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [isRemote, labels, path, sshConnectionId, toast]
  );

  const selectAndOpenApp = useCallback(
    (appId: OpenInAppId) => {
      persistPreferredApp(appId);
      void triggerOpenIn(appId);
    },
    [persistPreferredApp, triggerOpenIn]
  );

  const sortedApps = useMemo(() => {
    const availableApps = isRemote
      ? installedApps.filter(
          (app) => app.supportsRemote && (app.id !== 'terminal' || platform === 'darwin')
        )
      : installedApps;
    if (!defaultApp) return availableApps;
    return [...availableApps].sort((a, b) => {
      if (a.id === defaultApp) return -1;
      if (b.id === defaultApp) return 1;
      return 0;
    });
  }, [defaultApp, installedApps, isRemote, platform]);

  const menuApps = useMemo(
    () => sortedApps.filter((app) => !app.hideIfUnavailable || availability[app.id]),
    [availability, sortedApps]
  );

  const buttonAppId = useMemo(() => {
    if (defaultApp && menuApps.some((app) => app.id === defaultApp)) {
      return defaultApp;
    }
    return menuApps[0]?.id;
  }, [defaultApp, menuApps]);

  const buttonAppLabel = buttonAppId ? (labels[buttonAppId] ?? buttonAppId) : null;

  useEffect(() => {
    if (!buttonAppId || loading) return;
    return openInCommandRegistry.register({
      trigger: () => {
        void triggerOpenIn(buttonAppId);
      },
    });
  }, [buttonAppId, loading, triggerOpenIn]);

  return (
    <div
      className={cn(
        'flex h-6 items-center overflow-hidden rounded-md border border-border-subtle text-foreground-muted',
        borderless && 'border-none',
        className
      )}
    >
      <Tooltip.Provider delay={0}>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <button
                type="button"
                className={cn(
                  'group flex h-full min-w-0 flex-1 items-center rounded-l-md border-r border-border-subtle px-2 text-xs transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50',
                  borderless && 'border-none pr-1'
                )}
                onClick={() => {
                  if (!buttonAppId) return;
                  void triggerOpenIn(buttonAppId);
                }}
                disabled={!buttonAppId || loading}
                aria-label={buttonAppLabel ? `Open in ${buttonAppLabel}` : 'Open'}
              />
            }
          >
            {buttonAppId && <OpenInAppIcon appId={buttonAppId} src={icons[buttonAppId]} />}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">
            <div className="flex items-center gap-2">
              <span>Open in {buttonAppLabel || 'editor'}</span>
              <BoundShortcut command="app.openInEditor" variant="keycaps" />
            </div>
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
      <DropdownMenu.Root>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <DropdownMenu.Trigger
                className="group flex h-full w-6 shrink-0 items-center justify-center rounded-r-md border-none bg-transparent text-foreground-passive transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset data-[popup-open]:bg-surface-selected data-[popup-open]:text-foreground"
                aria-label="Open in options"
              >
                <ChevronDown className="size-3.5" />
              </DropdownMenu.Trigger>
            }
          ></Tooltip.Trigger>
          <Tooltip.Content side="bottom">Choose an app</Tooltip.Content>
        </Tooltip.Root>
        <DropdownMenu.Content align="end" sideOffset={6} width="content">
          <DropdownMenu.RadioGroup
            value={defaultApp ?? undefined}
            onValueChange={(value) => {
              if (isValidOpenInAppId(value)) selectAndOpenApp(value as OpenInAppId);
            }}
          >
            {menuApps.map((app) => {
              const isAvailable = loading
                ? availability[app.id] === true
                : availability[app.id] !== false;
              return (
                <DropdownMenu.RadioItem key={app.id} value={app.id} disabled={!isAvailable}>
                  <OpenInAppIcon
                    appId={app.id}
                    src={icons[app.id]}
                    alt={labels[app.id] || app.label}
                  />
                  {labels[app.id] || app.label}
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
};
