import { EmptyState } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  asAvailableProject,
  getProjectSettingsStore,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { ProjectSettingsForm } from '@core/features/projects/browser/components/settings-view/project-settings-form';
import { getProjectLiveActionDisabledReason } from '@core/features/projects/contributions/browser/project-live-action-guard';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useCurrentViewParams } from '@core/primitives/navigation/browser/navigation-hooks';
import type {
  ProjectDurableSettingsDomains,
  ProjectSettingsDomains,
} from '../../../api/project-settings-page';

export const SettingsPanel = observer(function SettingsPanel() {
  const {
    params: { projectId },
  } = useCurrentViewParams(projectViewDef);
  const context = asAvailableProject(getProjectStore(projectId));
  const store = getProjectSettingsStore(projectId);
  const hostDomains = store?.hostDomains;
  const domains =
    store?.domains ??
    (store?.durableDomains ? unavailableSettingsDomains(store.durableDomains) : null);
  const configMigrations = store?.configMigrations;
  const hostActionReason = context
    ? (getProjectLiveActionDisabledReason(projectId) ??
      (hostDomains?.kind === 'unavailable'
        ? `Settings from this Project’s ${
            context.project.type === 'local' ? 'Local runtime' : 'Machine'
          } are unavailable until they finish loading.`
        : null))
    : null;

  if ((!domains || !configMigrations) && store?.pageData.error) {
    return (
      <div className="flex min-h-60 flex-col">
        <EmptyState
          tone="error"
          label="Could not load project settings"
          description={store.pageData.error}
          action={
            <Button
              type="button"
              variant="text"
              disabled={store.pageData.loading}
              onClick={() => void store.load()}
            >
              {store.pageData.loading ? 'Retrying…' : 'Retry'}
            </Button>
          }
        />
      </div>
    );
  }

  if (!context || !store || !domains || !configMigrations) {
    return (
      <div className="flex min-h-60 flex-col">
        <EmptyState tone="loading" label="Loading settings…" />
      </div>
    );
  }

  return (
    <ProjectSettingsForm
      key={projectId}
      projectId={projectId}
      projectType={context.project.type}
      domains={domains}
      configMigrations={configMigrations}
      hostActionReason={hostActionReason}
      hostObservationKind={hostDomains?.kind ?? 'unavailable'}
      onSuccess={() => {}}
      save={(s) => store.save(s)}
      writeConfigToRepo={(request) => store.writeConfigToRepo(request)}
      migrateProjectConfig={(request) => store.migrateProjectConfig(request)}
    />
  );
});

function unavailableSettingsDomains(
  durable: ProjectDurableSettingsDomains
): ProjectSettingsDomains {
  return {
    gitIdentity: durable.gitIdentity,
    integrationAccounts: durable.integrationAccounts,
    placement: {
      ...durable.placement,
      layers: {
        hostWorktreeRoot: null,
        builtInWorktreeRoot: '',
        homeDirectory: '',
        hostTmux: null,
        appDefaultTmux: false,
      },
      resolved: {
        worktreeRoot: { value: '', provenance: { kind: 'unresolvable' } },
        tmux: {
          value: durable.placement.stored.tmux ?? false,
          provenance:
            durable.placement.stored.tmux === undefined
              ? { kind: 'inferred', from: 'app default' }
              : { kind: 'set' },
        },
      },
    },
    lifecycle: {
      personal: {},
      team: {},
      resolved: {
        autoRunSetup: { value: false, from: 'built-in' },
        autoRunRun: { value: false, from: 'built-in' },
      },
      sources: { prepare: [], setup: [], run: [], teardown: [] },
      writeTargets: [],
    },
    fileHandling: {
      personal: {},
      team: {},
      resolved: { preservePatterns: { value: [], from: 'built-in' } },
      sources: [],
      writeTargets: [],
    },
    environment: {
      personal: {},
      resolved: { env: { value: {}, from: 'built-in' } },
    },
  };
}
