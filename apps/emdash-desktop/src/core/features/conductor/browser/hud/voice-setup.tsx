import { CheckCircle2, Loader2, Mic, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';

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
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const settings = voice.settings;
  if (!settings) return null;
  const engine = settings.engine;
  const keyReady = engine === 'whisper-local' || Boolean(voice.status?.credentials[engine]);
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

  return (
    <section
      aria-label="Voice setup"
      className="pointer-events-auto w-full max-w-[560px] rounded-2xl border border-border bg-background/95 p-4 shadow-xl backdrop-blur"
    >
      <header className="mb-3 flex items-start gap-2">
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">Set up voice</p>
          <p className="text-xs text-foreground-muted">
            Talk to your agents: hold Right Ctrl, speak, release.
          </p>
        </div>
        <button
          type="button"
          aria-label="Skip voice setup"
          onClick={finish}
          className="flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-secondary hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <ol className="space-y-3 text-xs">
        <Step done={Boolean(keyReady)} title={`Speech engine: ${ENGINE_NAMES[engine]}`}>
          {keyReady ? (
            'Ready.'
          ) : (
            <>
              Needs an API key, or pick local whisper.cpp.{' '}
              <button
                type="button"
                className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => getNavigation().navigate(settingsViewDef({ tab: 'chorus' }))}
              >
                Open settings
              </button>
            </>
          )}
        </Step>

        <Step done={test.kind === 'done'} title="Say &ldquo;Hello Chorus&rdquo;">
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              disabled={!keyReady}
              onClick={() =>
                test.kind === 'recording' ? void voice.stopListening() : void runTest()
              }
              className="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {test.kind === 'recording' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Mic className="size-3.5" />
              )}
              {test.kind === 'recording' ? 'Stop' : 'Test'}
            </button>
            {test.kind === 'recording' && <MeterBar level={voice.level} />}
            {test.kind === 'done' && (
              <span className="min-w-0 truncate text-foreground">
                Heard &ldquo;{test.transcript}&rdquo;
                {voice.lastLatencyMs !== null ? ` in ${voice.lastLatencyMs} ms` : ''}
              </span>
            )}
            {test.kind === 'failed' && (
              <span className="min-w-0 truncate text-amber-700 dark:text-amber-300">
                {test.message}
              </span>
            )}
          </div>
        </Step>

        <Step done={false} title="Try a command">
          &ldquo;Show all&rdquo;, &ldquo;next&rdquo;, &ldquo;focus Atlas&rdquo;, or &ldquo;tell
          Bravo to run the tests&rdquo;. Hold Shift too to dictate into the focused agent.
        </Step>
      </ol>

      <footer className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={finish}
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
        >
          {test.kind === 'done' ? 'Done' : 'Finish later'}
        </button>
      </footer>
    </section>
  );
});

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-2">
      <CheckCircle2
        className={cn('mt-0.5 size-4 shrink-0', done ? 'text-green-600' : 'text-foreground/20')}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{title}</p>
        <div className="text-foreground-muted">{children}</div>
      </div>
    </li>
  );
}

function MeterBar({ level }: { level: number }) {
  return (
    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10">
      <span
        className="block h-full rounded-full bg-red-500 transition-[width] duration-75"
        style={{ width: `${Math.min(100, level * 100)}%` }}
      />
    </span>
  );
}
