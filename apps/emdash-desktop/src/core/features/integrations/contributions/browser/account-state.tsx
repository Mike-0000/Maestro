import { StateGlyph } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';
import type { ProviderAccountReportingState } from '@core/features/integrations/api/account-reporting';
import { getProjectViewStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';

export type BlockingProviderAccountState = Exclude<
  ProviderAccountReportingState,
  { kind: 'silent' }
>;

export function ProviderAccountStateEmpty({
  state,
  providerId,
  providerName,
  projectId,
  icon,
}: {
  state: BlockingProviderAccountState;
  providerId: string;
  providerName: string;
  projectId?: string;
  icon?: ReactNode;
}) {
  const openIntegrationSetup = useOpenModal('integrationSetupModal');
  const { navigate } = useNavigate();

  if (state.kind === 'disabled') {
    return <p className="px-4 py-3 text-center text-sm text-foreground-muted">{state.message}</p>;
  }
  if (state.kind === 'connect') {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
        {icon ? (
          <span className="flex size-6 items-center justify-center text-foreground-passive">
            {icon}
          </span>
        ) : null}
        <p className="max-w-64 text-sm text-foreground-muted">{state.message}</p>
        <Button
          type="button"
          variant="text"
          size="sm"
          onClick={() => {
            void openIntegrationSetup({ integration: providerId });
          }}
        >
          Connect {providerName}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
      <p className="flex max-w-64 items-start gap-2 text-sm text-foreground-muted">
        <StateGlyph state="error" className="mt-0.5" />
        <span>{state.message}</span>
      </p>
      {projectId ? (
        <Button
          type="button"
          variant="text"
          size="sm"
          onClick={() => {
            navigate(projectViewDef({ projectId }));
            getProjectViewStore(projectId)?.setProjectView('settings');
          }}
        >
          Open project settings
        </Button>
      ) : null}
    </div>
  );
}
