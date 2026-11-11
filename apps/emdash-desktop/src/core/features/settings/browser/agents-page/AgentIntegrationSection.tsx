import type { HostRef } from '@emdash/core/primitives/host/api';
import { Button, Spinner } from '@emdash/ui/react/primitives';
import { useAgentHooksStatus } from '@core/features/agents/api/browser/use-agent-hooks-status';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import type { AgentPayload } from '@core/primitives/agents/api';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { AgentSheetSection } from './agent-sheet-section';

const HOME_PREFIX_RE = /^\/(?:Users|home)\/[^/]+/;

function tildify(absolutePath: string): string {
  return absolutePath.replace(HOME_PREFIX_RE, '~');
}

export function AgentHooksSection({ agent, host }: { agent: AgentPayload; host: HostRef }) {
  const supportsHooks = agent.capabilities.hooks.kind !== 'none';
  const { status, isLoading } = useAgentHooksStatus(agent.id, host, supportsHooks);

  const showHooks = supportsHooks && (host.type !== 'remote' || isLoading || status !== undefined);
  if (!showHooks) return null;

  return (
    <AgentSheetSection
      title="Hooks"
      info="Hooks let Maestro track agent status, deliver notifications, and capture session IDs for reliable resume."
    >
      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-foreground-muted">
          <Spinner size="sm" className="text-foreground-passive" />
          Checking hooks…
        </p>
      ) : status?.state === 'installed' ? (
        <p className="min-w-0 text-xs text-foreground-muted" title={status.resolvedRoot}>
          <span className="text-foreground">Configured</span>
          <span className="text-foreground-passive"> · </span>
          <span className="font-mono break-all">{tildify(status.resolvedRoot)}</span>
        </p>
      ) : (
        <p className="text-xs text-foreground-muted">Configured when the first session starts.</p>
      )}
    </AgentSheetSection>
  );
}

export function AgentTrustSection({ agent }: { agent: AgentPayload }) {
  const supportsTrust = agent.capabilities.trust.kind !== 'none';
  const { value: taskSettings } = useAppSettingsKey('tasks');
  const { navigate } = useNavigate();

  if (!supportsTrust) return null;

  return (
    <AgentSheetSection
      title="Workspace trust"
      info="Skip the folder trust prompt in supported CLIs for new tasks."
      action={
        <Button
          type="button"
          variant="text"
          size="xs"
          onClick={() => navigate(settingsViewDef({ tab: 'general' }))}
        >
          Manage in Settings
        </Button>
      }
    >
      <p className="text-xs text-foreground-muted">
        {taskSettings?.autoTrustWorktrees
          ? 'On. New tasks skip the folder trust prompt.'
          : 'Off. The agent asks before it trusts a task folder.'}
      </p>
    </AgentSheetSection>
  );
}
