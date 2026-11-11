import { Sheet } from '@emdash/ui/react/primitives';
import { ArrowUpRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { agentSupportsAcp, type AgentPayload } from '@core/primitives/agents/api';

function formatSupportsText(agent: AgentPayload): string {
  const supportsSessions = agent.capabilities.sessions.kind !== 'stateless';
  const ways = agentSupportsAcp(agent.capabilities) ? 'Chat and terminal' : 'Terminal';
  return supportsSessions ? `${ways} · Prompts and sessions` : `${ways} · Prompts`;
}

/** The agent sheet's header: icon and name in the dialog-title role, then one line of facts. */
export const AgentSheetHeaderSection = observer(function AgentSheetHeaderSection({
  agent,
}: {
  agent: AgentPayload;
}) {
  return (
    <Sheet.Header>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center">
          <AgentIcon id={agent.id} size={24} />
        </span>
        <Sheet.Title className="truncate">{agent.name}</Sheet.Title>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-muted">
        <span>{formatSupportsText(agent)}</span>
        {agent.websiteUrl && (
          <a
            href={agent.websiteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 rounded-xs underline decoration-foreground-passive/60 underline-offset-4 outline-none hover:text-foreground hover:decoration-foreground-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            Website
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        )}
      </p>
    </Sheet.Header>
  );
});
