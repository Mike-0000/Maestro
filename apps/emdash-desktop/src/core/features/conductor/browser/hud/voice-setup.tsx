import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Kbd, Spinner } from '@emdash/ui/react/primitives';
import { Check, Mic } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import {
  getDictationStore,
  getVoiceStore,
} from '@core/features/voice/contributions/browser/app-stores';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { HudCard, HudCardHeader } from './hud-card';

const ENGINE_NAMES = {
  openai: 'OpenAI',
  deepgram: 'Deepgram',
  'whisper-local': 'local whisper.cpp',
  openrouter: 'OpenRouter',
} as const;

type TestState =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'done'; transcript: string }
  | { kind: 'failed'; message: string };

/**
 * First-run voice setup: shows which speech engine is ready and runs a "say hello" test that
 * transcribes without sending anything to the conductor.
 */
export const VoiceSetupPanel = observer(function VoiceSetupPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const voice = getVoiceStore();
  const dictation = getDictationStore();
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const settings = voice.settings;
  const local = settings?.localTranscriber ?? false;
  useEffect(() => {
    if (local) void dictation.refreshModel();
  }, [local, dictation]);
  if (!settings) return null;
  const engine = settings.engine;
  const keyReady = local
    ? dictation.model?.state === 'ready'
    : engine === 'whisper-local' || Boolean(voice.status?.credentials[engine]);
  const engineName = local ? 'Parakeet on this computer' : ENGINE_NAMES[engine];
  const finish = () => {
    void voice.updateSettings({ onboarded: true });
    onClose();
  };
  const runTest = async () => {
    setTest({ kind: 'recording' });
    const transcript = await voice.captureOnce();
    if (voice.error) setTest({ kind: 'failed', message: voice.error.message });
    else if (!transcript) {
      setTest({ kind: 'failed', message: 'Nothing was heard. Try again a bit louder.' });
    } else setTest({ kind: 'done', transcript });
  };
  const tested = test.kind === 'done';

  return (
    <HudCard label="Voice setup" className="px-5 py-4">
      <HudCardHeader title="Set up voice" onClose={finish} closeLabel="Skip voice setup" />
      <p className="text-xs text-foreground-muted">
        Talk to your agents: hold <Kbd>Right Ctrl</Kbd>, speak, release.
      </p>

      <ol className="mt-4 space-y-4">
        <Step done={Boolean(keyReady)} title={`Speech engine: ${engineName}`}>
          {keyReady ? (
            'Ready.'
          ) : (
            <>
              {local
                ? 'Needs the Parakeet model download.'
                : 'Needs an API key, or pick local whisper.cpp.'}{' '}
              <Button
                type="button"
                variant="text"
                size="xs"
                onClick={() => getNavigation().navigate(settingsViewDef({ tab: 'chorus' }))}
              >
                Open settings
              </Button>
            </>
          )}
        </Step>

        <Step done={tested} title="Say “Hello Maestro”">
          <div className="mt-1.5 flex min-h-7 items-center gap-3">
            <Button
              type="button"
              variant={tested ? 'ghost' : 'primary'}
              size="sm"
              disabled={!keyReady}
              onClick={() =>
                test.kind === 'recording' ? void voice.stopListening() : void runTest()
              }
            >
              {test.kind === 'recording' ? (
                <Spinner size="sm" />
              ) : (
                <Mic aria-hidden className="size-3.5" />
              )}
              {test.kind === 'recording' ? 'Stop' : 'Test'}
            </Button>
            {test.kind === 'recording' && <MeterBar level={voice.level} />}
            {test.kind === 'done' && (
              <span className="min-w-0 truncate text-foreground">
                Heard “{test.transcript}”
                {voice.lastLatencyMs !== null ? (
                  <span className="text-foreground-passive tabular-nums">
                    {' '}
                    in {voice.lastLatencyMs} ms
                  </span>
                ) : (
                  ''
                )}
              </span>
            )}
            {test.kind === 'failed' && (
              <span className="min-w-0 truncate text-foreground-warning">{test.message}</span>
            )}
          </div>
        </Step>

        <Step done={false} title="Try a command">
          “Show all”, “next”, “focus Atlas”, or “tell Bravo to run the tests”. Hold Shift too to
          dictate into the focused agent.
        </Step>
      </ol>

      <footer className="mt-5 flex justify-end">
        <Button type="button" variant={tested ? 'primary' : 'ghost'} size="sm" onClick={finish}>
          {tested ? 'Done' : 'Finish later'}
        </Button>
      </footer>
    </HudCard>
  );
});

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      {/* A full-strength check once done; the dim ring of an idle state until then. */}
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {done ? (
          <Check role="img" aria-label="Done" className="size-3.5 text-foreground" />
        ) : (
          <StateGlyph state="idle" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <div className="mt-0.5 text-xs text-foreground-muted">{children}</div>
      </div>
    </li>
  );
}

function MeterBar({ level }: { level: number }) {
  return (
    <span aria-hidden className="h-1 w-24 overflow-hidden rounded-full bg-surface-selected">
      <span
        className="block h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-75"
        style={{ width: `${Math.min(100, level * 100)}%` }}
      />
    </span>
  );
}
