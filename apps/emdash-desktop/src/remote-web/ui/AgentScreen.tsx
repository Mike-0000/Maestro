import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { MonitorUp } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useApp } from './app-context';
import { Spinner } from './controls';
import { cx, useIsWide } from './hooks';
import { Notice, ScreenFrame } from './ScreenFrame';
import { agentTone, TONE_TEXT } from './StatusIndicator';
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
          <div className="flex flex-1 items-center justify-center text-foreground-passive">
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
        <div className="flex flex-1 items-center justify-center text-foreground-passive">
          <Spinner className="size-5" />
        </div>
      </ScreenFrame>
    );
  }
  return <ChatAgent agent={agent} />;
});

/**
 * Chat-style agents are driven through structured turns rather than a terminal. This app does
 * not render those yet, so the pane shows where the agent stands and what it last said, set
 * like the desktop conductor's thread: the words on the paper, no cards. A chat transcript and
 * composer slot in here: the frame, status and routing are already shared.
 */
const ChatAgent = observer(function ChatAgent({ agent }: { agent: RemoteAgent }) {
  const app = useApp();
  const tone = agentTone(agent);
  const wide = useIsWide();
  return (
    <ScreenFrame title={agent.taskName} agent={agent}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="scroll-area px-safe flex-1">
          <div className="mx-auto flex w-full max-w-2xl flex-col px-5 pt-6 pb-28">
            {agent.message ? (
              <p className={cx('mb-6 text-body', TONE_TEXT[tone])}>{agent.message}</p>
            ) : null}

            <h2 className="text-caption text-foreground-passive">Last message</h2>
            {agent.lastAssistantMessage ? (
              <p className="text-reading mt-2 break-words whitespace-pre-wrap text-foreground-body select-text">
                {agent.lastAssistantMessage}
              </p>
            ) : (
              <p className="text-body mt-2 text-foreground-muted">
                This agent hasn’t said anything yet.
              </p>
            )}

            <p className="text-detail mt-8 flex gap-2.5 text-foreground-muted">
              <MonitorUp
                className="mt-px size-4 shrink-0 text-foreground-passive"
                aria-hidden="true"
              />
              <span>
                Chat agents can be followed here, but not answered yet. To reply, open this task in
                Maestro on {app.hostName}. Terminal agents can be fully controlled from this app.
              </span>
            </p>
          </div>
        </div>
        {wide ? null : (
          <VoiceFab className="right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))]" />
        )}
      </div>
    </ScreenFrame>
  );
});
