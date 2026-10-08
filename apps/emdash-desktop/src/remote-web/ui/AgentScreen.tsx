import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { MessageSquareText, MonitorUp } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useApp } from './app-context';
import { Spinner } from './controls';
import { cx, useIsWide } from './hooks';
import { Notice, ScreenFrame } from './ScreenFrame';
import { agentStatusLabel, agentTone, StatusIndicator, TONE_TEXT } from './StatusIndicator';
import { TerminalAgent } from './TerminalAgent';
import { VoiceFab } from './VoiceMic';

/** The detail pane for one agent, by conversation id. Handles "not loaded yet" and "gone". */
export const AgentScreen = observer(function AgentScreen({
  conversationId,
}: {
  conversationId: string;
}) {
  const app = useApp();
  const agent = app.agentById(conversationId);

  if (!agent) {
    return (
      <ScreenFrame title={app.overview ? 'Agent not found' : 'Agent'}>
        {app.overview && app.api ? (
          <Notice
            title="This agent is no longer here"
            body={`It may have been deleted on ${app.hostName}.`}
          />
        ) : (
          <div className="text-fg-passive flex flex-1 items-center justify-center">
            <Spinner className="size-5" />
            <span className="sr-only">Loading agent</span>
          </div>
        )}
      </ScreenFrame>
    );
  }

  // Keyed by conversation so switching agents on a wide screen starts a clean session.
  if (agent.kind === 'terminal' && app.api) {
    return <TerminalAgent key={conversationId} agent={agent} api={app.api} />;
  }
  if (agent.kind === 'terminal') {
    return (
      <ScreenFrame title={agent.taskName} agent={agent}>
        <div className="text-fg-passive flex flex-1 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      </ScreenFrame>
    );
  }
  return <ChatAgent agent={agent} />;
});

/**
 * Chat-style agents are driven through structured turns rather than a terminal. This app does
 * not render those yet, so the pane shows where the agent stands and what it last said. A chat
 * transcript and composer slot in here: the frame, status and routing are already shared.
 */
const ChatAgent = observer(function ChatAgent({ agent }: { agent: RemoteAgent }) {
  const app = useApp();
  const tone = agentTone(agent);
  const wide = useIsWide();
  return (
    <ScreenFrame title={agent.taskName} agent={agent}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="scroll-area px-safe flex-1">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 pt-5 pb-24">
            <div className="border-line bg-surface flex items-center gap-3 rounded-2xl border px-4 py-3.5">
              <StatusIndicator agent={agent} />
              <div className="min-w-0">
                <p className={cx('text-[15px] font-semibold', TONE_TEXT[tone])}>
                  {agentStatusLabel(agent)}
                </p>
                {agent.message ? (
                  <p className="text-fg-muted mt-0.5 text-[14px]">{agent.message}</p>
                ) : null}
              </div>
            </div>

            <article className="border-line bg-surface rounded-2xl border">
              <h2 className="border-line text-fg-muted flex items-center gap-2 border-b px-4 py-2.5 text-[12.5px] font-semibold tracking-wide uppercase">
                <MessageSquareText className="size-4" aria-hidden="true" />
                Last message
              </h2>
              {agent.lastAssistantMessage ? (
                <p className="px-4 py-3.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                  {agent.lastAssistantMessage}
                </p>
              ) : (
                <p className="text-fg-passive px-4 py-3.5 text-[14.5px]">
                  This agent hasn’t said anything yet.
                </p>
              )}
            </article>

            <div className="bg-surface-2 text-fg-muted flex gap-3 rounded-2xl px-4 py-3.5 text-[14px]">
              <MonitorUp className="mt-0.5 size-[18px] shrink-0" aria-hidden="true" />
              <p>
                Chat agents can be followed here, but not answered yet. To reply, open this task in
                Maestro on {app.hostName}. Terminal agents can be fully controlled from this app.
              </p>
            </div>
          </div>
        </div>
        {wide ? null : (
          <VoiceFab className="right-[max(1.25rem,env(safe-area-inset-right))] bottom-[max(1.25rem,env(safe-area-inset-bottom))]" />
        )}
      </div>
    </ScreenFrame>
  );
});
