import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { ChevronLeft } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { useApp, useRouter } from './app-context';
import { ReconnectingBar } from './ConnectionStatus';
import { Button, IconButton } from './controls';
import { cx, useIsWide } from './hooks';
import { agentStatusLabel, agentTone, TONE_TEXT } from './StatusIndicator';

type ScreenFrameProps = {
  title: string;
  agent?: RemoteAgent;
  actions?: ReactNode;
  children: ReactNode;
};

/** Header (back, title, status, actions) over a body that fills the rest of the pane. */
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
    <section aria-label={title} className="bg-canvas flex h-full min-w-0 flex-col">
      <header className="border-line px-safe pt-safe shrink-0 border-b">
        <div className="flex h-14 items-center gap-1 pr-2 pl-1.5">
          {wide ? (
            <span className="w-2.5" />
          ) : (
            <IconButton label="Back to agents" onClick={() => router.back()}>
              <ChevronLeft className="size-6" aria-hidden="true" />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[16px] leading-5 font-semibold">{title}</h1>
            {agent ? (
              <p className="text-fg-muted mt-px flex min-w-0 items-center gap-1.5 text-[12.5px] leading-4">
                <span className={cx('shrink-0 font-medium', TONE_TEXT[agentTone(agent)])}>
                  {agentStatusLabel(agent)}
                </span>
                <span aria-hidden="true" className="text-fg-passive">
                  ·
                </span>
                <span className="truncate">
                  {agentName}
                  {project ? ` · ${project}` : ''}
                </span>
              </p>
            ) : null}
          </div>
          {actions}
        </div>
      </header>
      {wide ? null : <ReconnectingBar />}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
});

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
      <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
      <p className="text-fg-muted mt-1.5 max-w-xs text-[14.5px]">{body}</p>
      <div className="mt-5 flex flex-col gap-2">
        {action}
        {wide ? null : (
          <Button variant="ghost" onClick={() => router.back()}>
            Back to agents
          </Button>
        )}
      </div>
    </div>
  );
}
