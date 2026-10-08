import { MousePointerClick, WifiOff } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { AgentList } from './AgentList';
import { AgentScreen } from './AgentScreen';
import { useApp, useRouter, useVoice } from './app-context';
import { BrandMark } from './BrandMark';
import { Button, Spinner } from './controls';
import { cx, useIsWide, useVisualViewport } from './hooks';
import { NewAgentSheet } from './NewAgentSheet';
import { PairingScreen } from './PairingScreen';
import { SettingsSheet } from './SettingsSheet';
import { Toasts } from './Toasts';
import { VoiceHud } from './VoiceHud';

export const App = observer(function App() {
  const app = useApp();
  const voice = useVoice();
  useVisualViewport();
  useEffect(() => app.start(), [app]);
  useEffect(() => voice.start(), [voice]);

  return (
    <div className="app-frame">
      {app.phase === 'loading' ? (
        <Splash />
      ) : app.phase === 'unreachable' ? (
        <Unreachable />
      ) : app.phase === 'unpaired' ? (
        <PairingScreen />
      ) : (
        <Workspace />
      )}
      <Toasts />
    </div>
  );
});

function Splash() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6">
      <BrandMark size={64} />
      <Spinner className="text-fg-passive size-5" />
      <span className="sr-only">Loading Maestro</span>
    </div>
  );
}

const Unreachable = observer(function Unreachable() {
  const app = useApp();
  return (
    <main className="pt-safe pb-safe flex h-full w-full flex-col items-center justify-center px-8 text-center">
      <span className="bg-surface-2 text-fg-muted flex size-14 items-center justify-center rounded-full">
        <WifiOff className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-5 text-[22px] font-semibold tracking-tight">Can’t reach your computer</h1>
      <p className="text-fg-muted mt-2 max-w-xs text-[15px]">
        Make sure it’s awake, Maestro is running, and this device is on your tailnet. Trying again
        automatically…
      </p>
      <Button variant="secondary" className="mt-6 px-6" onClick={() => void app.loadSession()}>
        Try now
      </Button>
    </main>
  );
});

/**
 * The paired app. A phone shows one screen at a time, the agent sliding over the list; a wide
 * window shows the list beside the agent. The list stays mounted underneath either way, so it
 * keeps its scroll position when you come back.
 */
const Workspace = observer(function Workspace() {
  const router = useRouter();
  const wide = useIsWide();
  const page = router.page;
  const detailOpen = page.name === 'agent';
  const sheet = router.route.name;

  return (
    <>
      <div
        inert={!wide && detailOpen}
        className={cx(
          'h-full min-w-0',
          wide ? 'w-[380px] shrink-0 border-r border-line' : 'w-full'
        )}
      >
        <AgentList />
      </div>

      {wide ? (
        <div className="h-full min-w-0 flex-1">
          {page.name === 'agent' ? (
            <AgentScreen conversationId={page.conversationId} />
          ) : (
            <NothingSelected />
          )}
        </div>
      ) : page.name === 'agent' ? (
        <div
          className={cx(
            'absolute inset-0 z-10',
            // Arriving by the back gesture, the system already animated; do not animate twice.
            router.lastNavigation === 'push' && 'animate-screen-in'
          )}
        >
          <AgentScreen conversationId={page.conversationId} />
        </div>
      ) : null}

      <VoiceHud />
      {sheet === 'new' ? <NewAgentSheet /> : null}
      {sheet === 'settings' ? <SettingsSheet /> : null}
    </>
  );
});

const NothingSelected = observer(function NothingSelected() {
  const app = useApp();
  const waiting = app.attentionCount;
  return (
    <div className="text-fg-muted flex h-full flex-col items-center justify-center px-8 text-center">
      <MousePointerClick className="text-fg-passive size-7" aria-hidden="true" />
      <p className="mt-4 text-[15px]">
        {waiting > 0
          ? `${waiting} ${waiting === 1 ? 'agent needs' : 'agents need'} you. Pick one to answer it.`
          : 'Select an agent to watch it work.'}
      </p>
    </div>
  );
});
