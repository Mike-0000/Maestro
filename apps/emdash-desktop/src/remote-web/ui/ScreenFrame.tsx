import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { ChevronLeft } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { useApp, useRouter } from './app-context';
import { ReconnectingBar } from './ConnectionStatus';
import { IconButton, TextAction } from './controls';
import { cx, useIsWide } from './hooks';
import { agentMark, agentStatusLabel, agentTone, StateMark, TONE_TEXT } from './StatusIndicator';

type ScreenFrameProps = {
  title: string;
  agent?: RemoteAgent;
  actions?: ReactNode;
  children: ReactNode;
};

/**
 * Header (back, title, state, actions) over a body that fills the rest of the pane. The header
 * is window chrome, on the sunken surface like the desktop's title bar; the body is the paper.
 */
export const ScreenFrame = observer(function ScreenFrame({
  title,
  agent,
  actions,
  children,
}: ScreenFrameProps) {
  const app = useApp();
  const router = useRouter();
  const wide = useIsWide();
  const project = agent ? app.projectName(agent.projectId) : '';
  const agentName = agent
    ? agent.title || app.providerName(agent.providerId) || agent.providerId
    : '';
  return (
    <section aria-label={title} className="surface-paper flex h-full min-w-0 flex-col bg-surface">
      <header className="surface-sunken px-safe pt-safe shrink-0 bg-surface">
        <div
          className={cx(
            'screen-header-row flex h-14 items-center gap-1 pr-1.5',
            wide ? 'pl-5' : 'pl-1'
          )}
        >
          {wide ? null : (
            <IconButton label="Back to agents" onClick={() => router.back()}>
              <ChevronLeft className="size-6" aria-hidden="true" />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-heading truncate font-semibold text-foreground">{title}</h1>
            {agent ? (
              <p className="text-caption flex min-w-0 items-center gap-1.5 text-foreground-passive">
                <StateMark state={agentMark(agent)} className="-mr-0.5 size-3" />
                <span className={cx('shrink-0', TONE_TEXT[agentTone(agent)])}>
                  {agentStatusLabel(agent)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="truncate">
                  {agentName}
                  {project ? ` · ${project}` : ''}
                </span>
              </p>
            ) : null}
          </div>
          {actions}
        </div>
        {wide ? null : <ReconnectingBar />}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
});

/** A page-level notice in a pane: a quiet title, one sentence, the way on. */
export function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const router = useRouter();
  const wide = useIsWide();
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <h2 className="text-title text-balance text-foreground">{title}</h2>
      <p className="text-body mt-3 max-w-xs text-balance text-foreground-muted">{body}</p>
      <div className="mt-8 flex flex-col items-center gap-1">
        {action}
        {wide ? null : <TextAction onClick={() => router.back()}>Back to agents</TextAction>}
      </div>
    </div>
  );
}
