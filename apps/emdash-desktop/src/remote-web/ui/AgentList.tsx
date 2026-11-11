import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { Archive, Plus, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { MouseEvent, ReactNode } from 'react';
import { agentPreview, type AgentGroup } from '../lib/agent-groups';
import { describeRelativeTime, formatRelativeTime } from '../lib/relative-time';
import { routePath, type Route } from '../state/router';
import { useApp, useRouter } from './app-context';
import { ConnectionStatus } from './ConnectionStatus';
import { Button, IconButton, Spinner, TextAction } from './controls';
import { cx, useIsWide } from './hooks';
import { agentMark, agentStatusLabel, agentTone, StateMark } from './StatusIndicator';
import { VoiceFab } from './VoiceMic';

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

/** "Nothing needs you" / "2 need you": the line the desktop sidebar opens with. */
function attentionSummary(count: number): string {
  if (count === 0) return 'Nothing needs you';
  return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}

/**
 * The agents, read like the desktop sidebar: the ones waiting on you first, each row its name,
 * what it last said or is asking, and its state in words, with the shared state marks.
 */
export const AgentList = observer(function AgentList() {
  const app = useApp();
  const router = useRouter();
  const wide = useIsWide();
  const loading = app.overview === null;
  const groups = app.groups;
  const selectedId = router.page.name === 'agent' ? router.page.conversationId : null;
  const openNew = (): void => router.push({ name: 'new' });

  return (
    <section aria-label="Agents" className="relative flex h-full min-w-0 flex-col bg-surface">
      <header className="px-safe pt-safe shrink-0">
        <div className="flex items-center gap-1 pt-3 pr-2 pb-1 pl-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-title text-foreground">Agents</h1>
            <p className="text-detail flex min-w-0 items-center gap-1.5 text-foreground-muted">
              <span className="truncate">{app.hostName}</span>
              {loading ? null : (
                <>
                  <span aria-hidden="true" className="text-foreground-passive">
                    ·
                  </span>
                  <span className="shrink-0">{attentionSummary(app.attentionCount)}</span>
                </>
              )}
              {app.linkStatus === 'online' ? null : (
                <span aria-hidden="true" className="text-foreground-passive">
                  ·
                </span>
              )}
              <ConnectionStatus showOnline={false} className="shrink-0" />
            </p>
          </div>
          <IconButton label="Settings" onClick={() => router.push({ name: 'settings' })}>
            <Settings className="size-5" aria-hidden="true" />
          </IconButton>
          {wide ? (
            <IconButton
              label="New agent"
              onClick={openNew}
              className="bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground active:bg-primary-hover"
            >
              <Plus className="size-5" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
        <FilterBar />
      </header>

      <div className="scroll-area px-safe min-h-0 flex-1">
        {loading ? (
          <ListLoading />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-5 px-2 pt-2 pb-28">
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
          className="bg-primary text-body text-primary-foreground shadow-float hover:bg-primary-hover active:bg-primary-hover absolute right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] flex h-14 items-center gap-2 rounded-full pr-5 pl-4 font-medium transition-colors duration-150"
        >
          <Plus className="size-5" aria-hidden="true" />
          New agent
        </button>
      ) : null}

      {loading ? null : (
        <VoiceFab
          className={
            wide
              ? 'right-4 bottom-4'
              : 'bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))]'
          }
        />
      )}
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
      className="no-scrollbar flex overflow-x-auto px-3.5 pb-1"
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

/** A quiet segment: a pill that fills one step when chosen, inside a 44px tap target. */
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
      className="group/chip flex h-11 shrink-0 items-center rounded-full px-0.5 outline-none"
    >
      <span
        className={cx(
          'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-detail font-medium whitespace-nowrap transition-colors duration-150',
          'group-focus-visible/chip:outline-2 group-focus-visible/chip:outline-offset-1 group-focus-visible/chip:outline-ring',
          selected
            ? 'bg-surface-selected text-foreground'
            : 'text-foreground-muted group-hover/chip:bg-surface-hover group-hover/chip:text-foreground'
        )}
      >
        {children}
      </span>
    </button>
  );
}

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
        className="text-caption flex items-baseline gap-1.5 px-3 pb-1 text-foreground-passive"
      >
        {group.label}
        <span className="tabular-nums">{group.agents.length}</span>
      </h2>
      <ul className="flex flex-col gap-0.5">
        {group.agents.map((agent) => (
          <li key={agent.conversationId}>
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
  const waiting = tone === 'attention';
  const project = app.projectName(agent.projectId);
  const agentName = agent.title || app.providerName(agent.providerId) || agent.providerId;
  return (
    <a
      href={routePath(route)}
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'flex gap-2.5 rounded-lg py-2.5 pr-3 pl-2.5 transition-colors duration-150 outline-offset-[-2px]',
        selected ? 'bg-surface-selected' : 'hover:bg-surface-hover active:bg-surface-hover'
      )}
    >
      <StateMark state={agentMark(agent)} className="mt-[3px]" />
      <div className={cx('min-w-0 flex-1', agent.archived && 'opacity-60')}>
        <div className="flex items-baseline gap-3">
          <span
            className={cx(
              'min-w-0 flex-1 truncate text-body text-foreground',
              waiting && 'font-medium'
            )}
          >
            {agent.taskName}
          </span>
          <time
            dateTime={
              agent.lastActivityAt === null
                ? undefined
                : new Date(agent.lastActivityAt).toISOString()
            }
            aria-label={describeRelativeTime(agent.lastActivityAt, app.now)}
            className="text-caption shrink-0 text-foreground-passive tabular-nums"
          >
            {formatRelativeTime(agent.lastActivityAt, app.now)}
          </time>
        </div>
        {preview ? (
          <p
            className={cx(
              'mt-0.5 text-detail break-words',
              waiting ? 'line-clamp-2 text-foreground' : 'line-clamp-1 text-foreground-muted'
            )}
          >
            {preview}
          </p>
        ) : null}
        <p className="text-caption mt-1 flex min-w-0 items-center gap-1.5 text-foreground-passive">
          <span className={cx('shrink-0', tone === 'error' && 'text-foreground-error')}>
            {agentStatusLabel(agent)}
          </span>
          <Dot />
          <span className="truncate">{agentName}</span>
          {project ? (
            <>
              <Dot />
              <span className="truncate">{project}</span>
            </>
          ) : null}
          {agent.archived ? (
            <>
              <Dot />
              <span className="shrink-0">Archived</span>
            </>
          ) : null}
        </p>
      </div>
    </a>
  );
});

function Dot() {
  return <span aria-hidden="true">·</span>;
}

/** A passive spinner and one line, shown only if loading takes longer than a moment. */
function ListLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading agents"
      className="animate-delayed-in text-detail flex items-center justify-center gap-2.5 pt-16 text-foreground-muted"
    >
      <Spinner className="size-4 text-foreground-passive" />
      Loading agents…
    </div>
  );
}

const EmptyState = observer(function EmptyState() {
  const app = useApp();
  const router = useRouter();
  const filtered = app.projectFilter !== null && app.agents.some((agent) => !agent.archived);
  return (
    <div className="animate-fade-in flex min-h-full flex-col items-center justify-center px-8 pt-6 pb-24 text-center">
      <h2 className="text-hero text-balance text-foreground">
        {filtered ? 'No agents in this project' : 'No agents running'}
      </h2>
      <p className="text-body mt-3 max-w-xs text-balance text-foreground-muted">
        {filtered
          ? 'Start one here, or switch back to all projects.'
          : `Start an agent on ${app.hostName} and steer it from here.`}
      </p>
      <div className="mt-8 flex flex-col items-center gap-1">
        <Button variant="primary" onClick={() => router.push({ name: 'new' })} className="px-6">
          <Plus className="size-5" aria-hidden="true" />
          New agent
        </Button>
        {filtered ? (
          <TextAction onClick={() => app.setProjectFilter(null)}>Show all projects</TextAction>
        ) : null}
      </div>
    </div>
  );
});
