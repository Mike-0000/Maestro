import { Sheet } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import {
  AgentHooksSection,
  AgentTrustSection,
} from '@core/features/settings/browser/agents-page/AgentIntegrationSection';
import {
  AgentMcpSection,
  useManageMcpSettingsNavigation,
} from '@core/features/settings/browser/agents-page/AgentMcpSection';
import { AgentSheetHeaderSection } from '@core/features/settings/browser/agents-page/AgentSheetHeaderSection';
import { InstalledAgentContent } from '@core/features/settings/browser/agents-page/InstalledAgentContent';
import { InstallSection } from '@core/features/settings/contributions/browser/agents-page/InstallSection';

interface AgentDetailSheetProps {
  agentId: string | null;
  connectionId?: string;
  onManageMcp?: () => void;
  onClose: () => void;
}

const AgentDetailSheetContent = observer(function AgentDetailSheetContent({
  agentId,
  connectionId,
  onManageMcp,
  onClose,
}: {
  agentId: string;
  connectionId?: string;
  onManageMcp?: () => void;
  onClose: () => void;
}) {
  const host = hostRefFromConnectionId(connectionId);
  const { data: agents } = useAgents(host);
  const agentPayload = agents?.find((a) => a.id === agentId);

  const {
    value: storedConfig,
    isOverridden,
    isLoading,
    update,
    reset,
  } = useAgentSettings(agentId, host);
  const navigateToMcpSettings = useManageMcpSettingsNavigation();

  const isInstalled = agentPayload?.status === 'available';
  const isRemote = !!connectionId;
  const handleManageMcp = isRemote
    ? onManageMcp &&
      (() => {
        onClose();
        onManageMcp();
      })
    : navigateToMcpSettings;

  return (
    <>
      {agentPayload ? (
        <AgentSheetHeaderSection agent={agentPayload} />
      ) : (
        <Sheet.Header>
          <Sheet.Title>{isInstalled ? 'Agent settings' : 'Install agent'}</Sheet.Title>
        </Sheet.Header>
      )}
      <Sheet.Body className="gap-8">
        {agentPayload && (
          <>
            <InstallSection
              agentId={agentId}
              connectionId={connectionId}
              agentPayload={agentPayload}
              installOptions={agentPayload.installOptions}
              installDocs={agentPayload.installDocs}
              hideOverrideOptions={!isInstalled || isRemote}
            />
            {isInstalled && <AgentHooksSection agent={agentPayload} host={host} />}
            {isInstalled && <AgentTrustSection agent={agentPayload} />}
            {isInstalled && (
              <AgentMcpSection agentId={agentId} host={host} onManage={handleManageMcp} />
            )}
            {isInstalled && (
              <InstalledAgentContent
                storedConfig={storedConfig}
                isOverridden={isOverridden}
                isLoading={isLoading}
                update={update}
                reset={reset}
                showWsl={
                  agentId === 'claude' && !isRemote && navigator.userAgent.includes('Windows')
                }
              />
            )}
          </>
        )}
      </Sheet.Body>
    </>
  );
});

export function AgentDetailSheet({
  agentId,
  connectionId,
  onManageMcp,
  onClose,
}: AgentDetailSheetProps) {
  return (
    <Sheet.Root open={agentId !== null} onOpenChange={(open) => !open && onClose()}>
      <Sheet.Content side="right">
        {agentId && (
          <AgentDetailSheetContent
            agentId={agentId}
            connectionId={connectionId}
            onManageMcp={onManageMcp}
            onClose={onClose}
          />
        )}
      </Sheet.Content>
    </Sheet.Root>
  );
}
