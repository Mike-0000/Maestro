import { Collapsible, Switch, Tooltip } from '@emdash/ui/react/primitives';
import { useMemo } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { useOpenInApps } from '@core/features/settings/api/browser/useOpenInApps';
import { OPEN_IN_APPS, type OpenInAppId } from '@core/primitives/open-in-apps/api/open-in-apps';
import IntegrationRow from './IntegrationRow';

/**
 * The "Open in" rows of the Interface page: every known editor and tool, installed ones first,
 * each with a switch for whether it appears in a task's Open in menu. Rows only; the page owns
 * the card.
 */
export default function HiddenToolsSettingsCard() {
  const { value: openIn, update, isLoading, isSaving } = useAppSettingsKey('openIn');
  const { icons, labels, availability } = useOpenInApps();

  const hiddenApps: OpenInAppId[] = openIn?.hidden ?? [];

  const toggle = (appId: OpenInAppId, visible: boolean) => {
    const next = visible ? hiddenApps.filter((id) => id !== appId) : [...hiddenApps, appId];
    update({ hidden: next });
  };

  const sortedApps = useMemo(() => {
    return Object.values(OPEN_IN_APPS).sort((a, b) => {
      const aDetected = availability[a.id] ?? a.alwaysAvailable ?? false;
      const bDetected = availability[b.id] ?? b.alwaysAvailable ?? false;
      if (aDetected && !bDetected) return -1;
      if (!aDetected && bDetected) return 1;
      return (labels[a.id] ?? a.label).localeCompare(labels[b.id] ?? b.label);
    });
  }, [availability, labels]);

  const isDetected = (app: (typeof sortedApps)[number]) =>
    availability[app.id] ?? app.alwaysAvailable ?? false;
  const installed = sortedApps.filter(isDetected);
  const missing = sortedApps.filter((app) => !isDetected(app));

  const renderRow = (app: (typeof sortedApps)[number]) => {
    const detected = isDetected(app);
    const isVisible = detected && !hiddenApps.includes(app.id);
    const label = labels[app.id] ?? app.label;

    return (
      <IntegrationRow
        key={app.id}
        logoSrc={icons[app.id]}
        invertInDark={app.invertInDark}
        name={label}
        status={detected ? 'connected' : 'missing'}
        showStatusPill={false}
        middle={
          detected ? null : (
            <span className="text-xs text-foreground-passive">Not found on this computer</span>
          )
        }
        rightExtra={
          <Tooltip.Root>
            <Tooltip.Trigger render={<span className="inline-flex" />}>
              <Switch
                checked={isVisible}
                disabled={isLoading || isSaving || !detected}
                onCheckedChange={(checked) => toggle(app.id, checked)}
                aria-label={`${isVisible ? 'Hide' : 'Show'} ${label} in open menu`}
              />
            </Tooltip.Trigger>
            <Tooltip.Content side="top">
              {!detected
                ? 'Install this tool to show it in the menu'
                : isVisible
                  ? 'Hide from the menu'
                  : 'Show in the menu'}
            </Tooltip.Content>
          </Tooltip.Root>
        }
      />
    );
  };

  return (
    <Tooltip.Provider delay={150}>
      <div className="flex flex-col gap-1">
        {installed.map(renderRow)}
        {missing.length > 0 ? (
          <Collapsible.Root className={installed.length > 0 ? 'mt-2' : undefined}>
            <Collapsible.Trigger variant="text">
              {missing.length === 1
                ? '1 tool not found on this computer'
                : `${missing.length} tools not found on this computer`}
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <div className="flex flex-col gap-1 pt-2">{missing.map(renderRow)}</div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}
