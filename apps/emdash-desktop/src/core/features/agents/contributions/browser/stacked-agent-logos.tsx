import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';

interface StackedAgentLogosProps {
  /** Map of providerId to conversation count, same shape as task.conversationStats */
  stats: Record<string, number>;
}

export function StackedAgentLogos({ stats }: StackedAgentLogosProps) {
  const entries = Object.entries(stats);
  const { data: agents } = useAgentMetadata();
  if (entries.length === 0) return null;

  const nameMap = new Map((agents ?? []).map((a) => [a.id, a.name]));

  return (
    // Overlapping tiles on the emphasis step, each cut out of the row by a ring in the page
    // colour. A second conversation with the same agent shows as a count after its tile in the
    // caption role, not as a badge squeezed into the 20px tile.
    <div className="flex shrink-0 items-center [&>span]:ring-2 [&>span]:ring-background [&>span:not(:first-child)]:-ml-1">
      {entries.map(([providerId, count]) => {
        const name = nameMap.get(providerId) ?? providerId;
        return (
          <span
            key={providerId}
            className="relative flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-xs bg-surface-emphasis px-0.5"
            title={count > 1 ? `${name}: ${String(count)}` : name}
          >
            <AgentIcon id={providerId} size={14} />
            {count > 1 && (
              <span className="pr-px text-micro leading-none text-foreground-muted tabular-nums">
                {count}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
