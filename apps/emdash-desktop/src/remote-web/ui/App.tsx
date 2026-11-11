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
    <div className="app-frame surface-sunken">
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
      <BrandMark size={56} />
      <Spinner className="size-5 text-foreground-passive" />
      <span className="sr-only">Loading Maestro</span>
    </div>
  );
}

/** The page-level error: a quiet title, one sentence, one action. It keeps retrying itself. */
const Unreachable = observer(function Unreachable() {
  const app = useApp();
  return (
    <main className="pt-safe pb-safe flex h-full w-full flex-col items-center justify-center px-8 text-center">
      <h1 className="text-hero max-w-sm text-balance text-foreground">Can’t reach your computer</h1>
      <p className="text-body mt-3 max-w-xs text-balance text-foreground-muted">
        Make sure it’s awake, Maestro is running, and this device is on your tailnet. Trying again
        automatically…
      </p>
      <Button variant="secondary" className="mt-8 px-6" onClick={() => void app.loadSession()}>
        Try now
      </Button>
    </main>
  );
});

/**
 * The paired app. A phone shows one screen at a time, the agent sliding over the list; a wide
 * window shows the list beside the agent, like the desktop's sidebar beside its content. The
 * list stays mounted underneath either way, so it keeps its scroll position when you come back.
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
        className={cx('h-full min-w-0', wide ? 'w-[380px] shrink-0' : 'w-full')}
      >
        <AgentList />
      </div>

      {wide ? (
        <div className="surface-paper h-full min-w-0 flex-1 bg-surface">
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
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-title text-foreground">
        {waiting > 0
          ? `${waiting} ${waiting === 1 ? 'agent needs' : 'agents need'} you`
          : 'Nothing needs you'}
      </h2>
      <p className="text-body mt-3 max-w-xs text-balance text-foreground-muted">
        {waiting > 0 ? 'Pick one from the list to answer it.' : 'Pick an agent to watch it work.'}
      </p>
    </div>
  );
});
