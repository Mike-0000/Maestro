import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { Archive, Plus, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { MouseEvent, ReactNode } from 'react';
import { agentPreview, type AgentGroup } from '../lib/agent-groups';
import { describeRelativeTime, formatRelativeTime } from '../lib/relative-time';
import { routePath, type Route } from '../state/router';
import { useApp, useRouter } from './app-context';
import { BrandMark } from './BrandMark';
import { ConnectionStatus } from './ConnectionStatus';
import { Button, IconButton } from './controls';
import { cx, useIsWide } from './hooks';
import { agentStatusLabel, agentTone, StatusIndicator } from './StatusIndicator';

/** Follows an in-app link without a page load, leaving modified clicks to the browser. */
function useLinkHandler(route: Route): (event: MouseEvent<HTMLAnchorElement>) => void {
  const router = useRouter();
  return (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.push(route);
  };
}

export const AgentList = observer(function AgentList() {
  const app = useApp();
  const router = useRouter();
  const wide = useIsWide();
  const loading = app.overview === null;
  const groups = app.groups;
  const selectedId = router.page.name === 'agent' ? router.page.conversationId : null;
  const openNew = (): void => router.push({ name: 'new' });

  return (
    <section aria-label="Agents" className="bg-canvas relative flex h-full min-w-0 flex-col">
      <header className="px-safe pt-safe">
        <div className="flex items-end gap-1 px-5 pt-4 pb-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] leading-8 font-bold tracking-tight">Agents</h1>
            <div className="text-fg-muted mt-1 flex min-w-0 items-center gap-2 text-[13px]">
              <span className="truncate">{app.hostName}</span>
              <span aria-hidden="true" className="text-fg-passive">
                ·
              </span>
              <ConnectionStatus className="shrink-0" />
            </div>
          </div>
          <IconButton label="Settings" onClick={() => router.push({ name: 'settings' })}>
            <Settings className="size-[21px]" aria-hidden="true" />
          </IconButton>
          {wide ? (
            <IconButton
              label="New agent"
              onClick={openNew}
              className="bg-primary text-primary-fg hover:bg-primary-hover hover:text-primary-fg"
            >
              <Plus className="size-[21px]" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
        <FilterBar />
      </header>

      <div className="scroll-area px-safe min-h-0 flex-1">
        {loading ? (
          <ListSkeleton />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-5 px-3 pt-2 pb-28">
            {groups.map((group) => (
              <GroupSection key={group.id} group={group} selectedId={selectedId} />
            ))}
          </div>
        )}
      </div>

      {!wide && !loading && groups.length > 0 ? (
        <button
          type="button"
          onClick={openNew}
          aria-label="New agent"
          className="bg-primary text-primary-fg absolute right-[max(1.25rem,env(safe-area-inset-right))] bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex h-14 items-center gap-2 rounded-full pr-5 pl-4 text-[15px] font-semibold shadow-lg shadow-black/30 transition-transform duration-150 active:scale-95"
        >
          <Plus className="size-5" strokeWidth={2.5} aria-hidden="true" />
          New agent
        </button>
      ) : null}
    </section>
  );
});

const FilterBar = observer(function FilterBar() {
  const app = useApp();
  const projects = app.filterProjects;
  const showProjects = projects.length > 1 || app.projectFilter !== null;
  if (!showProjects && app.archivedCount === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Filter agents"
      className="no-scrollbar flex gap-2 overflow-x-auto px-5 pt-1 pb-3"
    >
      {showProjects ? (
        <>
          <Chip selected={app.projectFilter === null} onClick={() => app.setProjectFilter(null)}>
            All
          </Chip>
          {projects.map((project) => (
            <Chip
              key={project.id}
              selected={app.projectFilter === project.id}
              onClick={() =>
                app.setProjectFilter(app.projectFilter === project.id ? null : project.id)
              }
            >
              {project.name}
            </Chip>
          ))}
        </>
      ) : null}
      {app.archivedCount > 0 ? (
        <Chip
          selected={app.showArchived}
          onClick={() => app.setShowArchived(!app.showArchived)}
          label={app.showArchived ? 'Hide archived agents' : 'Show archived agents'}
        >
          <Archive className="size-3.5" aria-hidden="true" />
          Archived
        </Chip>
      ) : null}
    </div>
  );
});

function Chip({
  selected,
  onClick,
  label,
  children,
}: {
  selected: boolean;
  onClick(): void;
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-medium whitespace-nowrap transition-colors duration-150',
        selected
          ? 'border-transparent bg-fg text-fg-inverse'
          : 'border-line-strong text-fg-muted hover:bg-surface-2 hover:text-fg'
      )}
    >
      {children}
    </button>
  );
}

const GROUP_ACCENT: Record<AgentGroup['id'], string> = {
  attention: 'text-attention',
  working: 'text-fg-muted',
  idle: 'text-fg-muted',
};

const GroupSection = observer(function GroupSection({
  group,
  selectedId,
}: {
  group: AgentGroup;
  selectedId: string | null;
}) {
  const headingId = `group-${group.id}`;
  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        className={cx(
          'flex items-baseline gap-2 px-2.5 pb-1.5 text-[12.5px] font-semibold tracking-wide uppercase',
          GROUP_ACCENT[group.id]
        )}
      >
        {group.label}
        <span className="text-fg-passive font-medium tabular-nums">{group.agents.length}</span>
      </h2>
      <ul
        className={cx(
          'overflow-hidden rounded-2xl border bg-surface',
          group.id === 'attention' ? 'border-attention-line/60' : 'border-line'
        )}
      >
        {group.agents.map((agent, index) => (
          <li key={agent.conversationId} className={cx(index > 0 && 'border-t border-line')}>
            <AgentRow agent={agent} selected={agent.conversationId === selectedId} />
          </li>
        ))}
      </ul>
    </section>
  );
});

const AgentRow = observer(function AgentRow({
  agent,
  selected,
}: {
  agent: RemoteAgent;
  selected: boolean;
}) {
  const app = useApp();
  const route: Route = { name: 'agent', conversationId: agent.conversationId };
  const onClick = useLinkHandler(route);
  const preview = agentPreview(agent);
  const tone = agentTone(agent);
  const project = app.projectName(agent.projectId);
  const agentName = agent.title || app.providerName(agent.providerId) || agent.providerId;
  return (
    <a
      href={routePath(route)}
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'flex gap-3 px-3.5 py-3 transition-colors duration-100 outline-offset-[-2px]',
        selected ? 'bg-surface-3' : 'hover:bg-surface-2 active:bg-surface-2',
        agent.archived && 'opacity-60'
      )}
    >
      <StatusIndicator agent={agent} className="mt-px" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15.5px] leading-5 font-semibold">
            {agent.taskName}
          </span>
          <time
            dateTime={
              agent.lastActivityAt === null
                ? undefined
                : new Date(agent.lastActivityAt).toISOString()
            }
            aria-label={describeRelativeTime(agent.lastActivityAt, app.now)}
            className="text-fg-passive shrink-0 text-[12.5px] tabular-nums"
          >
            {formatRelativeTime(agent.lastActivityAt, app.now)}
          </time>
        </div>
        <div className="text-fg-muted mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <span className="truncate">{agentName}</span>
          {project ? (
            <>
              <span aria-hidden="true" className="text-fg-passive">
                ·
              </span>
              <span className="truncate">{project}</span>
            </>
          ) : null}
          {agent.archived ? (
            <span className="bg-surface-3 text-fg-muted shrink-0 rounded-full px-1.5 text-[11px]">
              Archived
            </span>
          ) : null}
        </div>
        {preview ? (
          <p
            className={cx(
              'mt-1.5 line-clamp-2 text-[13.5px] leading-[1.38]',
              tone === 'attention' ? 'text-fg' : 'text-fg-muted'
            )}
          >
            {preview}
          </p>
        ) : (
          <p className="text-fg-passive mt-1.5 text-[13.5px]">{agentStatusLabel(agent)}</p>
        )}
      </div>
    </a>
  );
});

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading agents" className="px-3 pt-2">
      <div className="bg-surface-2 mx-2.5 mb-2 h-3 w-20 rounded" />
      <div className="border-line bg-surface overflow-hidden rounded-2xl border">
        {[72, 56, 64].map((width, index) => (
          <div
            key={width}
            className={cx(
              'flex animate-pulse gap-3 px-3.5 py-3.5',
              index > 0 && 'border-t border-line'
            )}
          >
            <div className="bg-surface-3 mt-1 size-3 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="bg-surface-3 h-3.5 rounded" style={{ width: `${width}%` }} />
              <div className="bg-surface-2 h-3 w-2/5 rounded" />
              <div className="bg-surface-2 h-3 w-4/5 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const EmptyState = observer(function EmptyState() {
  const app = useApp();
  const router = useRouter();
  const filtered = app.projectFilter !== null && app.agents.some((agent) => !agent.archived);
  return (
    <div className="animate-fade-in flex min-h-full flex-col items-center justify-center px-8 pt-6 pb-24 text-center">
      <div className="opacity-90">
        <BrandMark size={56} />
      </div>
      <h2 className="mt-5 text-[19px] font-semibold tracking-tight">
        {filtered ? 'No agents in this project' : 'No agents running'}
      </h2>
      <p className="text-fg-muted mt-1.5 max-w-xs text-[14.5px]">
        {filtered
          ? 'Start one here, or switch back to all projects.'
          : `Start an agent on ${app.hostName} and steer it from here.`}
      </p>
      <div className="mt-6 flex flex-col gap-2">
        <Button variant="primary" onClick={() => router.push({ name: 'new' })} className="px-6">
          <Plus className="size-[18px]" strokeWidth={2.5} aria-hidden="true" />
          New agent
        </Button>
        {filtered ? (
          <Button variant="ghost" onClick={() => app.setProjectFilter(null)}>
            Show all projects
          </Button>
        ) : null}
      </div>
    </div>
  );
});
