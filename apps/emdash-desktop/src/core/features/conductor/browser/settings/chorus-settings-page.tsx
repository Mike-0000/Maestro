import { PageLayout, SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Input, Select, Switch, Textarea } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import {
  DEFAULT_TALK_SETTINGS,
  isTalkAgentId,
  TALK_VOICE_STYLE_MAX_CHARS,
  TALK_VOICES,
} from '@core/features/talk/api/contract';
import { TALK_MODELS } from '@core/features/talk/api/usage';
import { getTalkStore } from '@core/features/talk/contributions/browser/app-stores';
import {
  GEMINI_VOICE_STYLE_MAX_CHARS,
  LOCAL_SPEECH_MODEL_LABELS,
  localSpeechModelSchema,
} from '@core/features/voice/api/contract';
import {
  acceleratorFromCodes,
  acceleratorLabel,
  HOLD_KEY_OFF,
  holdComboFromCodes,
  holdComboLabel,
} from '@core/features/voice/api/global-keys';
import {
  getDictationStore,
  getVoiceStore,
} from '@core/features/voice/contributions/browser/app-stores';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import {
  copyTextToClipboard,
  getHostClient,
} from '@core/primitives/desktop-host/browser/host-client';
import { getConductorClient } from '../../api/browser/client';
import { CODE_CHECKS_UI, type SystemChecks } from '../../api/contract';
import { STANDING_LIMITS, type InstructionChange } from '../../api/standing-instructions';
import { getConductorStore } from '../../contributions/browser/app-stores';
import { KeyCaptureControl } from './key-capture-control';

function DiagnosticControls({ enabled }: { enabled: boolean }) {
  const conductor = getConductorStore();
  const [message, setMessage] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      <Button
        variant="text"
        size="xs"
        disabled={!enabled}
        onClick={() => {
          if (
            !window.confirm(
              'Copy up to 200 recent voice events to the clipboard? Share them only with an agent you trust.'
            )
          )
            return;
          void (async () => {
            try {
              const events = await conductor.recentTrace();
              await copyTextToClipboard(events.map((event) => JSON.stringify(event)).join('\n'));
              setMessage(`Copied ${events.length} events. Paste them into an agent you trust.`);
            } catch {
              setMessage('Could not copy the events.');
            }
          })();
        }}
      >
        Copy recent events
      </Button>
      {/* A quiet text action like its neighbour; the confirm carries the weight (brief 2.7). */}
      <Button
        variant="text"
        size="xs"
        onClick={() => {
          if (
            !window.confirm(
              'Delete all saved voice history from this computer? This cannot be undone.'
            )
          )
            return;
          void (async () => {
            try {
              await (await getConductorClient()).deleteDiagnostics();
              setMessage('Voice history deleted.');
            } catch {
              setMessage('Could not delete the voice history.');
            }
          })();
        }}
      >
        Delete history
      </Button>
      <span role="status" className="text-foreground-muted">
        {message}
      </span>
    </div>
  );
}

const ENGINE_LABELS = {
  openai: 'OpenAI',
  deepgram: 'Deepgram',
  'whisper-local': 'whisper.cpp on your computer',
  openrouter: 'OpenRouter',
} as const;

const TTS_ENGINE_LABELS = {
  platform: 'Windows voice, offline',
  kitten: 'Kitten Mini, offline',
  'gemini-flash': 'Gemini 3.8 Flash, best quality',
  'gemini-flash-lite': 'Gemini 3.8 Flash-Lite, faster',
  'openrouter-gemini-flash': 'Gemini 3.8 Flash on OpenRouter',
  'openrouter-gemini-flash-lite': 'Gemini 3.8 Flash-Lite on OpenRouter',
  'vertex-gemini-flash': 'Gemini 3.8 Flash on Google Cloud',
  'vertex-gemini-flash-lite': 'Gemini 3.8 Flash-Lite on Google Cloud',
} as const;
type TtsEngine = keyof typeof TTS_ENGINE_LABELS;

function isTtsEngine(value: unknown): value is TtsEngine {
  return typeof value === 'string' && value in TTS_ENGINE_LABELS;
}

/** Cloud engines speak with Gemini voices (prebuilt or custom), whichever key they use. */
function usesGeminiVoice(engine: TtsEngine | undefined): boolean {
  return engine !== undefined && engine !== 'platform' && engine !== 'kitten';
}

const JEV_SOURCE_LABELS = {
  auto: 'Automatic',
  openrouter: 'OpenRouter',
  typesafe: 'TypeSafe',
} as const;

const CALL_MODE_LABELS = {
  off: 'Off',
  quiet: 'Show on screen',
  spoken: 'Read aloud',
} as const;

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
} as const;

type Effort = keyof typeof EFFORT_LABELS;

/** The efforts Grok Voice takes: it reasons, or it does not. */
const TALK_EFFORT_LABELS = {
  none: 'Off',
  high: 'High',
} as const;

type TalkEffort = keyof typeof TALK_EFFORT_LABELS;

function isTalkEffort(value: string): value is TalkEffort {
  return value in TALK_EFFORT_LABELS;
}

/** The selected on-device model behind dictation and "Transcribe on this computer". */
const LocalTranscriberModel = observer(function LocalTranscriberModel() {
  const dictation = getDictationStore();
  const model = dictation.model;
  if (!model) return <span className="text-xs text-foreground-muted">Checking the model…</span>;
  if (model.state === 'ready') {
    return <span className="text-xs text-foreground-muted">Downloaded and ready.</span>;
  }
  if (model.state === 'downloading') {
    const percent =
      model.totalBytes > 0 ? Math.round((model.receivedBytes / model.totalBytes) * 100) : 0;
    return (
      <span className="text-xs text-foreground-muted tabular-nums" role="status">
        Downloading: {percent}%
      </span>
    );
  }
  return (
    <div className="flex items-center gap-4 text-xs">
      <span className="text-foreground-warning" role="status">
        {model.state === 'failed'
          ? `Download failed: ${model.message ?? 'unknown error'}`
          : 'Not downloaded yet, and voice commands need it.'}
      </span>
      <Button
        variant="text"
        size="xs"
        className="shrink-0"
        onClick={() => void dictation.downloadModel()}
      >
        {model.state === 'failed'
          ? 'Try again'
          : `Download ${Math.round(model.totalBytes / 1_000_000)} MB`}
      </Button>
    </div>
  );
});

export const ChorusSettingsPage = observer(function ChorusSettingsPage() {
  const voice = getVoiceStore();
  const conductor = getConductorStore();
  const dictation = getDictationStore();
  useEffect(() => {
    void voice.refreshStatus();
    void conductor.refreshStatus();
    void dictation.refreshModel();
  }, [voice, conductor, dictation]);

  const voiceSettings = voice.settings;
  const conductorSettings = conductor.settings;
  const credentials = voice.status?.credentials;

  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        draggable
        title="Voice & Conductor"
        description="Talk to your agents by voice. Your keys are stored encrypted on this computer."
      />
      <div className="flex flex-col gap-10">
        <WindowsChecks />

        <SettingsSection title="Troubleshooting">
          <SettingsRow
            label="Keep a voice history"
            description="Saves recent commands and replies on this computer; turning it off deletes them."
            control={
              <Switch
                checked={conductorSettings?.diagnosticHistory ?? false}
                disabled={!conductorSettings}
                onCheckedChange={(diagnosticHistory) =>
                  void conductor.updateSettings({ diagnosticHistory })
                }
              />
            }
          />
          <SettingsRow
            label="Days to keep"
            description="Up to 30 days, and at most 2 MB per file."
            control={
              <CommitInput
                value={String(conductorSettings?.diagnosticDays ?? 7)}
                ariaLabel="Days to keep the voice history"
                className="w-24"
                onCommit={(value) => {
                  const days = Number(value);
                  if (Number.isInteger(days) && days >= 1 && days <= 30)
                    void conductor.updateSettings({ diagnosticDays: days });
                }}
              />
            }
          />
          <DiagnosticControls enabled={conductorSettings?.diagnosticHistory ?? false} />
        </SettingsSection>

        <SettingsSection title="Provider">
          <SettingsRow
            label="Use OpenRouter for everything"
            description="One OpenRouter key runs the conductor, speech-to-text and quick decisions."
            control={
              <Switch
                checked={
                  conductorSettings?.provider === 'openrouter' &&
                  voiceSettings?.engine === 'openrouter' &&
                  conductorSettings.jevSource !== 'typesafe'
                }
                disabled={!conductorSettings || !voiceSettings}
                onCheckedChange={(useOpenRouter) => {
                  void conductor.updateSettings({
                    provider: useOpenRouter ? 'openrouter' : 'anthropic',
                  });
                  void voice.updateSettings({ engine: useOpenRouter ? 'openrouter' : 'openai' });
                  void conductor.updateSettings({
                    jevSource: useOpenRouter ? 'openrouter' : 'auto',
                  });
                }}
              />
            }
          />
        </SettingsSection>

        <SettingsSection title="API keys">
          <KeyRow
            id="anthropic"
            label="Anthropic"
            description="Runs the conductor on Claude; basic commands work without it."
            present={credentials?.anthropic}
            onSaved={() => void conductor.refreshStatus()}
          />
          <KeyRow
            id="openrouter"
            label="OpenRouter"
            description="Can run the conductor, speech-to-text, quick decisions and Gemini voices."
            present={credentials?.openrouter}
            onSaved={() => void conductor.refreshStatus()}
          />
          <KeyRow
            id="typesafe"
            label="TypeSafe"
            description="Another way to run quick decisions; not needed if you use OpenRouter."
            present={credentials?.typesafe}
            onSaved={() => void conductor.refreshStatus()}
          />
          <KeyRow
            id="openai"
            label="OpenAI"
            description="Turns your speech into text."
            present={credentials?.openai}
          />
          <KeyRow
            id="xai"
            label="xAI"
            description="Runs the live voice conductor on Grok Voice."
            present={credentials?.xai}
            onSaved={() => void getTalkStore().refreshStatus()}
          />
          <KeyRow
            id="deepgram"
            label="Deepgram"
            description="Turns your speech into text and is tuned to hear agent names."
            present={credentials?.deepgram}
          />
          <KeyRow
            id="gemini"
            label="Google Gemini"
            description="Reads replies aloud with Gemini voices; Google bills by the length of audio."
            present={credentials?.gemini}
          />
        </SettingsSection>

        <SettingsSection title="Canvas">
          <CanvasSettings />
        </SettingsSection>

        <SettingsSection title="Voice">
          <SettingsRow
            label="Speech-to-text engine"
            description="The service that turns your speech into text."
            control={
              <Select.Root
                value={voiceSettings?.engine ?? 'openai'}
                disabled={!voiceSettings}
                onValueChange={(engine) => {
                  if (engine) void voice.updateSettings({ engine });
                }}
              >
                <Select.Trigger appearance="input" className="w-56">
                  <Select.Value>{ENGINE_LABELS[voiceSettings?.engine ?? 'openai']}</Select.Value>
                </Select.Trigger>
                <Select.Content align="end">
                  {Object.entries(ENGINE_LABELS).map(([id, label]) => (
                    <Select.Item key={id} value={id}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            }
          />
          <SettingsRow
            label="Transcribe on this computer"
            description="Turn voice commands into text here, so no audio leaves this computer."
            control={
              <Switch
                checked={voiceSettings?.localTranscriber ?? false}
                disabled={!voiceSettings}
                onCheckedChange={(localTranscriber) => {
                  void voice.updateSettings({ localTranscriber });
                  if (localTranscriber) void dictation.refreshModel();
                }}
              />
            }
          />
          <SettingsRow
            label="Speech model on this computer"
            description="Used for dictation and for transcribing here; Ultra understands 25 languages, Unified only English."
            control={
              <Select.Root
                value={voiceSettings?.localSpeechModel ?? 'parakeet-ultra'}
                disabled={!voiceSettings}
                onValueChange={(value) => {
                  const parsed = localSpeechModelSchema.safeParse(value);
                  if (!parsed.success) return;
                  void voice
                    .updateSettings({ localSpeechModel: parsed.data })
                    .then(() => dictation.refreshModel());
                }}
              >
                <Select.Trigger appearance="input" className="w-56">
                  <Select.Value>
                    {LOCAL_SPEECH_MODEL_LABELS[voiceSettings?.localSpeechModel ?? 'parakeet-ultra']}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="end">
                  {Object.entries(LOCAL_SPEECH_MODEL_LABELS).map(([id, label]) => (
                    <Select.Item key={id} value={id}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            }
          />
          {voiceSettings?.localTranscriber && (
            <SettingsRow
              label="Speech model download"
              description="Download it once, and transcription then works offline."
              control={<LocalTranscriberModel />}
            />
          )}
          {voiceSettings?.engine === 'whisper-local' && (
            <SettingsRow
              layout="stacked"
              label="whisper.cpp server address"
              description="The web address of your running whisper.cpp server."
              control={
                <CommitInput
                  value={voiceSettings.whisperUrl}
                  ariaLabel="whisper.cpp server address"
                  className="max-w-xl"
                  onCommit={(whisperUrl) => void voice.updateSettings({ whisperUrl })}
                />
              }
            />
          )}
          {voiceSettings?.engine === 'openrouter' && (
            <SettingsRow
              label="OpenRouter speech model"
              description="Any OpenRouter model that understands audio, such as google/gemini-3.5-flash-lite."
              control={
                <CommitInput
                  value={voiceSettings.openrouterSttModel}
                  ariaLabel="OpenRouter speech model"
                  onCommit={(openrouterSttModel) =>
                    void voice.updateSettings({ openrouterSttModel })
                  }
                />
              }
            />
          )}
          <SettingsRow
            label="Language"
            description="The two-letter code for the language you speak, such as en, de or fr."
            control={
              <CommitInput
                value={voiceSettings?.language ?? 'en'}
                ariaLabel="Language"
                className="w-20"
                onCommit={(language) => void voice.updateSettings({ language })}
              />
            }
          />
          <SettingsRow
            label="Hold to talk anywhere"
            description={
              voiceSettings &&
              voiceSettings.globalHoldKey !== HOLD_KEY_OFF &&
              voice.status &&
              !voice.status.globalHoldActive
                ? 'These keys could not be set up, so hold to talk works only inside Maestro.'
                : 'Hold to talk in any app, or double-tap to keep listening; your typing is never recorded.'
            }
            control={
              <KeyCaptureControl
                label={holdComboLabel(voiceSettings?.globalHoldKey ?? HOLD_KEY_OFF)}
                ariaLabel="Hold to talk anywhere key"
                disabled={!voiceSettings}
                resolve={holdComboFromCodes}
                onCommit={(globalHoldKey) => void voice.updateSettings({ globalHoldKey })}
                onClear={() => void voice.updateSettings({ globalHoldKey: HOLD_KEY_OFF })}
              />
            }
          />
          <SettingsRow
            label="Talk shortcut"
            description={
              voiceSettings?.globalShortcut &&
              voice.status &&
              !voice.status.globalShortcutRegistered
                ? 'Another app uses this shortcut or Windows does not allow it, so pick another.'
                : 'Starts or stops listening from any app; inside Maestro you can also hold Right Ctrl.'
            }
            control={
              <KeyCaptureControl
                label={
                  voiceSettings?.globalShortcut
                    ? acceleratorLabel(voiceSettings.globalShortcut)
                    : null
                }
                ariaLabel="Talk shortcut"
                disabled={!voiceSettings}
                resolve={acceleratorFromCodes}
                onCommit={(globalShortcut) => void voice.updateSettings({ globalShortcut })}
                onClear={() => void voice.updateSettings({ globalShortcut: '' })}
              />
            }
          />
          <SettingsRow
            label="Live transcript"
            description="Show your words as you speak, with Deepgram."
            control={
              <Switch
                checked={voiceSettings?.streaming ?? true}
                disabled={!voiceSettings}
                onCheckedChange={(streaming) => void voice.updateSettings({ streaming })}
              />
            }
          />
          <SettingsRow
            label="Hands-free"
            description="Always listen and act on anything that starts with the wake phrase; this costs more."
            control={
              <Switch
                checked={voiceSettings?.handsFree ?? false}
                disabled={!voiceSettings}
                onCheckedChange={(handsFree) => void voice.updateSettings({ handsFree })}
              />
            }
          />
          {voiceSettings?.handsFree && (
            <SettingsRow
              label="Wake phrase"
              description="Say it first, as in “Maestro, focus Claude 1”; empty means act on everything."
              control={
                <CommitInput
                  value={voiceSettings.wakePhrase}
                  ariaLabel="Wake phrase"
                  className="w-40"
                  allowEmpty
                  onCommit={(wakePhrase) => void voice.updateSettings({ wakePhrase })}
                />
              }
            />
          )}
          <SettingsRow
            label="Speak replies"
            description="Read the conductor's answers aloud."
            control={
              <Switch
                checked={voiceSettings?.speakReplies ?? true}
                disabled={!voiceSettings}
                onCheckedChange={(speakReplies) => void voice.updateSettings({ speakReplies })}
              />
            }
          />
          <SettingsRow
            label="Announce agents that need you"
            description="Say “Codex 1 needs permission” when an agent waits or finishes."
            control={
              <Switch
                checked={voiceSettings?.speakAttention ?? true}
                disabled={!voiceSettings}
                onCheckedChange={(speakAttention) => void voice.updateSettings({ speakAttention })}
              />
            }
          />
          <SettingsRow
            label="Voice for replies"
            description={
              voiceSettings?.ttsEngine.startsWith('openrouter-') && !credentials?.openrouter
                ? 'Add an OpenRouter key above; until then, replies use the Windows voice.'
                : voiceSettings?.ttsEngine.startsWith('vertex-')
                  ? 'Uses your Google Cloud sign-in and bills your project; the Windows voice is the backup.'
                  : 'Kitten Mini stays on this computer; Gemini voices send reply text to Google.'
            }
            control={
              <Select.Root
                value={voiceSettings?.ttsEngine ?? 'platform'}
                disabled={!voiceSettings}
                onValueChange={(engine) => {
                  if (isTtsEngine(engine)) void voice.updateSettings({ ttsEngine: engine });
                }}
              >
                <Select.Trigger appearance="input" className="w-72">
                  <Select.Value>
                    {TTS_ENGINE_LABELS[voiceSettings?.ttsEngine ?? 'platform']}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="end">
                  {(Object.keys(TTS_ENGINE_LABELS) as TtsEngine[]).map((engine) => (
                    <Select.Item key={engine} value={engine}>
                      {TTS_ENGINE_LABELS[engine]}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            }
          />
          {voiceSettings?.ttsEngine === 'kitten' && (
            <SettingsRow
              label="Kitten Mini voice"
              description="An English voice that comes with Maestro, with nothing to download."
              control={
                <Select.Root
                  value={voiceSettings.localVoice}
                  onValueChange={(localVoice) => {
                    if (
                      localVoice === 'Bella' ||
                      localVoice === 'Jasper' ||
                      localVoice === 'Luna' ||
                      localVoice === 'Bruno' ||
                      localVoice === 'Rosie' ||
                      localVoice === 'Hugo' ||
                      localVoice === 'Kiki' ||
                      localVoice === 'Leo'
                    ) {
                      void voice.updateSettings({ localVoice });
                    }
                  }}
                >
                  <Select.Trigger appearance="input" className="w-56">
                    <Select.Value>{voiceSettings.localVoice}</Select.Value>
                  </Select.Trigger>
                  <Select.Content align="end">
                    {(
                      ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'] as const
                    ).map((name) => (
                      <Select.Item key={name} value={name}>
                        {name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              }
            />
          )}
          {usesGeminiVoice(voiceSettings?.ttsEngine) && (
            <SettingsRow
              label="Gemini voice"
              description="A built-in English voice, used unless you set a custom Gemini voice."
              control={
                <Select.Root
                  value={voiceSettings?.geminiVoice ?? 'Kore'}
                  disabled={!voiceSettings}
                  onValueChange={(geminiVoice) => {
                    if (
                      geminiVoice === 'Kore' ||
                      geminiVoice === 'Puck' ||
                      geminiVoice === 'Aoede' ||
                      geminiVoice === 'Zephyr'
                    ) {
                      void voice.updateSettings({ geminiVoice });
                    }
                  }}
                >
                  <Select.Trigger appearance="input" className="w-56">
                    <Select.Value>{voiceSettings?.geminiVoice ?? 'Kore'}</Select.Value>
                  </Select.Trigger>
                  <Select.Content align="end">
                    {(['Kore', 'Puck', 'Aoede', 'Zephyr'] as const).map((name) => (
                      <Select.Item key={name} value={name}>
                        {name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              }
            />
          )}
          {usesGeminiVoice(voiceSettings?.ttsEngine) && (
            <SettingsRow
              label="Custom Gemini voice"
              description={`The id of a voice you designed; it works only with the Google Cloud choices.${
                voiceSettings?.geminiCustomVoice.trim() &&
                !voiceSettings.ttsEngine.startsWith('vertex-')
                  ? ' The voice above cannot use it, so pick a Google Cloud choice.'
                  : ''
              }`}
              control={
                <CommitInput
                  value={voiceSettings?.geminiCustomVoice ?? ''}
                  ariaLabel="Custom Gemini voice id"
                  placeholder="voice_…"
                  className="w-64 font-mono text-xs"
                  allowEmpty
                  onCommit={(value) =>
                    void voice.updateSettings({ geminiCustomVoice: value.trim().slice(0, 200) })
                  }
                />
              }
            />
          )}
          {voiceSettings?.ttsEngine.startsWith('vertex-') && (
            <SettingsRow
              layout="stacked"
              label="Google Cloud voice style"
              description="How the voice should sound, in your own words; leave empty to let it choose."
              control={
                <Textarea
                  key={voiceSettings.geminiVoiceStyle}
                  defaultValue={voiceSettings.geminiVoiceStyle}
                  aria-label="Google Cloud voice style"
                  placeholder="Laid-back and unhurried, like chatting with a friend…"
                  rows={4}
                  maxLength={GEMINI_VOICE_STYLE_MAX_CHARS}
                  className="max-w-xl"
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next !== voiceSettings.geminiVoiceStyle) {
                      void voice.updateSettings({ geminiVoiceStyle: next });
                    }
                  }}
                />
              }
            />
          )}
          {voiceSettings?.ttsEngine.startsWith('vertex-') && (
            <SettingsRow
              label="Google Cloud project"
              description="The project that holds your custom voices; leave empty to use your default."
              control={
                <CommitInput
                  value={voiceSettings.vertexProject}
                  ariaLabel="Google Cloud project id"
                  placeholder="Project id"
                  className="w-64 font-mono text-xs"
                  allowEmpty
                  onCommit={(value) =>
                    void voice.updateSettings({ vertexProject: value.trim().slice(0, 100) })
                  }
                />
              }
            />
          )}
          <SettingsRow
            label="Windows backup voice"
            description="Used when the voice above fails; Test plays the voice you chose."
            control={<VoicePicker />}
          />
        </SettingsSection>

        <SettingsSection title="Conductor">
          <SettingsRow
            label="AI service"
            description="Use Claude with an Anthropic key, or pick a model on OpenRouter."
            control={
              <Select.Root
                value={conductorSettings?.provider ?? 'anthropic'}
                disabled={!conductorSettings}
                onValueChange={(provider) => {
                  if (provider) void conductor.updateSettings({ provider });
                }}
              >
                <Select.Trigger appearance="input" className="w-56">
                  <Select.Value>
                    {conductorSettings?.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="end">
                  <Select.Item value="anthropic">Anthropic</Select.Item>
                  <Select.Item value="openrouter">OpenRouter</Select.Item>
                </Select.Content>
              </Select.Root>
            }
          />
          {conductorSettings?.provider === 'openrouter' ? (
            <SettingsRow
              label="OpenRouter model"
              description="The id of an OpenRouter model that supports tool use."
              control={
                <CommitInput
                  value={conductorSettings.openrouterModel}
                  ariaLabel="OpenRouter conductor model"
                  onCommit={(openrouterModel) => void conductor.updateSettings({ openrouterModel })}
                />
              }
            />
          ) : (
            <SettingsRow
              label="Claude model"
              description="The Claude model that plans and carries out your commands."
              control={
                <CommitInput
                  value={conductorSettings?.model ?? ''}
                  ariaLabel="Conductor model"
                  onCommit={(model) => void conductor.updateSettings({ model })}
                />
              }
            />
          )}
          <SettingsRow
            label="Effort for commands"
            description="How hard it thinks about everyday commands; lower is faster."
            control={
              <EffortSelect
                value={conductorSettings?.commandEffort}
                onChange={(commandEffort) => void conductor.updateSettings({ commandEffort })}
              />
            }
          />
          <SettingsRow
            label="Effort for plans"
            description="How hard it thinks when splitting a goal across several agents."
            control={
              <EffortSelect
                value={conductorSettings?.planEffort}
                onChange={(planEffort) => void conductor.updateSettings({ planEffort })}
              />
            }
          />
          <SettingsRow
            label="Max agents per plan"
            control={
              <CommitInput
                value={String(conductorSettings?.maxAgentsPerPlan ?? 4)}
                ariaLabel="Max agents per plan"
                className="w-20"
                onCommit={(value) => {
                  const maxAgentsPerPlan = Number.parseInt(value, 10);
                  if (maxAgentsPerPlan >= 1 && maxAgentsPerPlan <= 12) {
                    void conductor.updateSettings({ maxAgentsPerPlan });
                  }
                }}
              />
            }
          />
          <SettingsRow
            label="Quick decisions"
            description={
              conductor.status?.jevReady
                ? `A fast model handles simple commands and checks, through ${conductor.status.jevVia === 'openrouter' ? 'OpenRouter' : 'TypeSafe'}.`
                : conductorSettings?.jevEnabled === false
                  ? 'Let a fast model handle simple commands and checks.'
                  : 'Add an OpenRouter or TypeSafe key above to turn this on.'
            }
            control={
              <Switch
                checked={conductorSettings?.jevEnabled ?? true}
                disabled={!conductorSettings}
                onCheckedChange={(jevEnabled) => void conductor.updateSettings({ jevEnabled })}
              />
            }
          />
          <SettingsRow
            label="Service for quick decisions"
            description="Automatic uses a key you have, preferring the one the conductor uses."
            control={
              <Select.Root
                value={conductorSettings?.jevSource ?? 'auto'}
                disabled={!conductorSettings}
                onValueChange={(jevSource) => {
                  if (jevSource) void conductor.updateSettings({ jevSource });
                }}
              >
                <Select.Trigger appearance="input" className="w-56">
                  <Select.Value>
                    {JEV_SOURCE_LABELS[conductorSettings?.jevSource ?? 'auto']}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="end">
                  {Object.entries(JEV_SOURCE_LABELS).map(([id, label]) => (
                    <Select.Item key={id} value={id}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            }
          />
          <SettingsRow
            label="Confidence to act"
            description="How sure the fast model must be, from 0.5 to 0.99, before it acts alone."
            control={
              <CommitInput
                value={String(conductorSettings?.jevConfidence ?? 0.8)}
                ariaLabel="Confidence the fast model needs to act"
                className="w-20"
                onCommit={(value) => {
                  const jevConfidence = Number.parseFloat(value);
                  if (jevConfidence >= 0.5 && jevConfidence <= 0.99) {
                    void conductor.updateSettings({ jevConfidence });
                  }
                }}
              />
            }
          />
          <SettingsRow
            label="Send your exact words"
            description="When the fast model is sure, it passes on your own words instead of rewording them."
            control={
              <Switch
                checked={conductorSettings?.jevVerbatimRouting ?? true}
                disabled={!conductorSettings || conductorSettings.jevEnabled === false}
                onCheckedChange={(jevVerbatimRouting) =>
                  void conductor.updateSettings({ jevVerbatimRouting })
                }
              />
            }
          />
          <SettingsRow
            label="Start plans without asking"
            description="Start a plan's agents right away instead of waiting for your yes."
            control={
              <Switch
                checked={conductorSettings?.autoApprovePlans ?? false}
                disabled={!conductorSettings}
                onCheckedChange={(autoApprovePlans) =>
                  void conductor.updateSettings({ autoApprovePlans })
                }
              />
            }
          />
          <SettingsRow
            label="Report what finished agents said"
            description="When an agent finishes, the conductor tells you what it did and handles any follow-ups."
            control={
              <Switch
                checked={conductorSettings?.completionFollowUp ?? true}
                disabled={!conductorSettings}
                onCheckedChange={(completionFollowUp) =>
                  void conductor.updateSettings({ completionFollowUp })
                }
              />
            }
          />
          <SettingsRow
            label="Let the conductor decide who needs you"
            description="The conductor reads each agent's last reply to tell whether it needs you or is done."
            control={
              <Switch
                checked={conductorSettings?.attentionVerdicts ?? true}
                disabled={!conductorSettings}
                onCheckedChange={(attentionVerdicts) =>
                  void conductor.updateSettings({ attentionVerdicts })
                }
              />
            }
          />
          <SettingsRow
            label="Only tell me when an agent needs me"
            description="Finished agents that need nothing from you show on screen, with no sound or alert."
            control={
              <Switch
                checked={conductorSettings?.announceCompletions === 'attention_only'}
                disabled={!conductorSettings || conductorSettings.attentionVerdicts === false}
                onCheckedChange={(quiet) =>
                  void conductor.updateSettings({
                    announceCompletions: quiet ? 'attention_only' : 'all',
                  })
                }
              />
            }
          />
          <SettingsRow
            label="Let agents ask the conductor"
            description="Agents can ask the conductor to start or message other agents, or to reach you."
            control={
              <Switch
                checked={conductorSettings?.agentRequests ?? true}
                disabled={!conductorSettings}
                onCheckedChange={(agentRequests) =>
                  void conductor.updateSettings({ agentRequests })
                }
              />
            }
          />
          <SettingsRow
            label="Calls from agents"
            description="Agents reach you one at a time; tap Right Ctrl to answer the one on the line."
            control={
              <Select.Root
                value={conductorSettings?.calls ?? 'off'}
                disabled={!conductorSettings}
                onValueChange={(calls) => {
                  if (calls) void conductor.updateSettings({ calls });
                }}
              >
                <Select.Trigger appearance="input" className="w-56">
                  <Select.Value>{CALL_MODE_LABELS[conductorSettings?.calls ?? 'off']}</Select.Value>
                </Select.Trigger>
                <Select.Content align="end">
                  {Object.entries(CALL_MODE_LABELS).map(([id, label]) => (
                    <Select.Item key={id} value={id}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            }
          />
          <SettingsRow
            label="Seconds a call stays on the line"
            description="How long you have to answer a call, from 2 to 30 seconds."
            control={
              <CommitInput
                value={String(conductorSettings?.callWindowSec ?? 6)}
                ariaLabel="Seconds a call stays on the line"
                className="w-20"
                onCommit={(value) => {
                  const callWindowSec = Number.parseInt(value, 10);
                  if (callWindowSec >= 2 && callWindowSec <= 30) {
                    void conductor.updateSettings({ callWindowSec });
                  }
                }}
              />
            }
          />
          <SettingsRow
            label="Daily token limit"
            description={
              conductor.status
                ? `Used today: ${formatTokens(conductor.status.usageToday.inputTokens + conductor.status.usageToday.outputTokens)}, plus ${formatTokens(conductor.status.usageToday.cacheReadTokens)} reused. 0 means no limit.`
                : '0 means no limit.'
            }
            control={
              <CommitInput
                value={String(conductorSettings?.dailyTokenBudget ?? 0)}
                ariaLabel="Daily token limit"
                className="w-32"
                onCommit={(value) => {
                  const dailyTokenBudget = Number.parseInt(value.replace(/[,_\s]/g, ''), 10);
                  if (dailyTokenBudget >= 0) void conductor.updateSettings({ dailyTokenBudget });
                }}
              />
            }
          />
          <SettingsRow
            label="Conversation memory"
            description="The conductor remembers your last few exchanges; clear them to start fresh."
            control={
              <Button variant="text" size="xs" onClick={() => conductor.clearHistory()}>
                Clear
              </Button>
            }
          />
        </SettingsSection>

        <SettingsSection title="Chat conductors">
          <SettingsRow
            label="Give each chat its own conductor"
            description="A conductor for each chat follows its agent and tells you in writing what matters."
            control={
              <Switch
                checked={conductorSettings?.chatConductors ?? true}
                disabled={!conductorSettings}
                onCheckedChange={(chatConductors) =>
                  void conductor.updateSettings({ chatConductors })
                }
              />
            }
          />
          <SettingsRow
            label="Effort for chat conductors"
            description="Higher reads each agent's work more carefully but costs more."
            control={
              <EffortSelect
                value={conductorSettings?.chatConductorEffort}
                onChange={(chatConductorEffort) =>
                  void conductor.updateSettings({ chatConductorEffort })
                }
              />
            }
          />
          <SettingsRow
            label="New chats can act for me"
            description="While you are away, a chat's conductor may answer or prompt its agent for you."
            control={
              <Switch
                checked={conductorSettings?.chatConductorAutonomy ?? true}
                disabled={!conductorSettings}
                onCheckedChange={(chatConductorAutonomy) =>
                  void conductor.updateSettings({ chatConductorAutonomy })
                }
              />
            }
          />
          <SettingsRow
            label="Conductors decide when you are told"
            description="Each chat's conductor decides whether its agent needs you and whether to alert you."
            control={
              <Switch
                checked={conductorSettings?.conductorDecidesAttention ?? true}
                disabled={!conductorSettings || !(conductorSettings.chatConductors ?? true)}
                onCheckedChange={(conductorDecidesAttention) =>
                  void conductor.updateSettings({ conductorDecidesAttention })
                }
              />
            }
          />
        </SettingsSection>

        <StandingInstructionSettings />

        <TalkLineSettings />

        {CODE_CHECKS_UI && <CodeCheckSettings />}
      </div>
    </div>
  );
});

/**
 * What the developer told the conductor to do from now on. The conductor saves these itself
 * when asked by voice; here they can be read, added, and taken back.
 */
const StandingInstructionSettings = observer(function StandingInstructionSettings() {
  const conductor = getConductorStore();
  const saved = conductor.status?.instructions ?? [];
  const [message, setMessage] = useState('');
  const change = (input: InstructionChange) => {
    void conductor
      .adjustInstructions(input)
      .then((result) => setMessage(result.success ? '' : result.error.message))
      .catch(() => setMessage('The instruction could not be saved.'));
  };
  return (
    <SettingsSection title="Standing instructions">
      <SettingsRow
        layout="stacked"
        label="How the conductor should act from now on"
        description={`Tell the conductor “from now on, keep prompts short”, or type an instruction here. ${saved.length} of ${STANDING_LIMITS.entries} saved.${message ? ` ${message}` : ''}`}
        control={
          <CommitInput
            // A new field once one is saved, so what was typed does not stay in it.
            key={saved.length}
            value=""
            ariaLabel="New standing instruction"
            placeholder="Add an instruction…"
            className="max-w-xl"
            onCommit={(text) => change({ action: 'add', text })}
          />
        }
      />
      {saved.map((entry) => (
        <SettingsRow
          key={entry.id}
          label={entry.id}
          description={entry.text}
          control={
            <Button
              variant="text"
              size="xs"
              aria-label={`Remove standing instruction ${entry.id}`}
              onClick={() => change({ action: 'remove', id: entry.id })}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
});

const INVESTIGATOR_MODELS = { haiku: 'Haiku, fast and low cost', sonnet: 'Sonnet' } as const;

/**
 * Extra folders a code check may read besides the project. Each one is checked in the main
 * process before it is saved, and again before every check.
 */
const CodeCheckFolders = observer(function CodeCheckFolders() {
  const conductor = getConductorStore();
  const folders = conductor.settings?.investigationFolders ?? [];
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const add = async () => {
    if (adding) return;
    setAdding(true);
    setMessage('');
    try {
      const chosen = await (
        await getHostClient()
      ).openSelectDirectoryDialog({
        title: 'Add a folder for code checks',
        message: 'Choose a folder the conductor may read but not change.',
      });
      if (!chosen) return;
      const check = await (await getConductorClient()).checkInvestigationFolder({ path: chosen });
      if (!check.ok) {
        setMessage(check.reason);
        return;
      }
      if (folders.includes(check.path)) return;
      await conductor.updateSettings({ investigationFolders: [...folders, check.path] });
    } catch {
      setMessage('The folder could not be added.');
    } finally {
      setAdding(false);
    }
  };
  return (
    <>
      <SettingsRow
        label="Extra folders"
        description={`Other folders the conductor may read but not change; secret files are never read. ${folders.length === 0 ? 'None yet, so only the project is read.' : ''}${message ? ` ${message}` : ''}`}
        control={
          <Button
            variant="text"
            size="xs"
            disabled={!conductor.settings || adding}
            onClick={() => void add()}
          >
            {adding ? 'Choosing…' : 'Add folder…'}
          </Button>
        }
      />
      {folders.map((folder) => (
        <SettingsRow
          key={folder}
          label={<span className="font-mono text-xs break-all">{folder}</span>}
          control={
            <Button
              variant="text"
              size="xs"
              onClick={() =>
                void conductor.updateSettings({
                  investigationFolders: folders.filter((other) => other !== folder),
                })
              }
            >
              Remove
            </Button>
          }
        />
      ))}
    </>
  );
});

/**
 * Code checks and project lookups: a read-only Claude Code process that answers the conductor's
 * questions about a project's files, and a search that finds where a name appears in one.
 */
const CodeCheckSettings = observer(function CodeCheckSettings() {
  const conductor = getConductorStore();
  const settings = conductor.settings;
  const status = conductor.status;
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    void getConductorClient()
      // The self-test runs the CLI three times; the default call deadline is too short for it.
      .then((client) => client.recheckInvestigator(undefined, { timeoutMs: 0 }))
      .then(() => conductor.refreshStatus())
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };
  const investigator = status?.investigator;
  const state = checking
    ? 'Checking…'
    : investigator?.state === 'ready'
      ? 'Ready.'
      : investigator?.state === 'unavailable'
        ? `Not available: ${investigator.reason ?? 'unknown reason'}.`
        : 'Off.';
  const model = settings?.investigatorModel ?? 'haiku';
  return (
    <SettingsSection title="Code checks">
      <SettingsRow
        label="Let the conductor read project files"
        description={`The conductor reads your project before writing prompts; file contents go to Anthropic. ${state}`}
        control={
          <Switch
            checked={settings?.investigations ?? false}
            disabled={!settings || checking}
            onCheckedChange={(investigations) => {
              void conductor.updateSettings({ investigations }).then(() => {
                if (investigations) recheck();
              });
            }}
          />
        }
      />
      <SettingsRow
        label="Model for code checks"
        description="Haiku is quick and answered every test question correctly."
        control={
          <Select.Root
            value={model}
            disabled={!settings}
            onValueChange={(investigatorModel) => {
              if (investigatorModel) void conductor.updateSettings({ investigatorModel });
            }}
          >
            <Select.Trigger appearance="input" className="w-56">
              <Select.Value>
                {INVESTIGATOR_MODELS[model as keyof typeof INVESTIGATOR_MODELS] ?? model}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              {Object.entries(INVESTIGATOR_MODELS).map(([id, label]) => (
                <Select.Item key={id} value={id}>
                  {label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        }
      />
      <SettingsRow
        label="Seconds one question may take"
        description="Between 15 and 60; a check that runs longer is stopped."
        control={
          <CommitInput
            value={String(settings?.investigationTimeoutSec ?? 45)}
            ariaLabel="Seconds one question may take"
            className="w-20"
            onCommit={(value) => {
              const investigationTimeoutSec = Number.parseInt(value, 10);
              if (investigationTimeoutSec >= 15 && investigationTimeoutSec <= 60) {
                void conductor.updateSettings({ investigationTimeoutSec });
              }
            }}
          />
        }
      />
      <SettingsRow
        label="Questions a day"
        description={
          status
            ? `Asked today: ${status.usageToday.investigations ?? 0}, about $${(status.usageToday.investigationCostUsd ?? 0).toFixed(2)}. 0 means no limit.`
            : '0 means no limit.'
        }
        control={
          <CommitInput
            value={String(settings?.investigationsPerDay ?? 100)}
            ariaLabel="Code check questions a day"
            className="w-20"
            onCommit={(value) => {
              const investigationsPerDay = Number.parseInt(value, 10);
              if (investigationsPerDay >= 0) {
                void conductor.updateSettings({ investigationsPerDay });
              }
            }}
          />
        }
      />
      <SettingsRow
        label="Daily spending limit in US dollars"
        description="The most code checks may cost in a day; 0 means no limit."
        control={
          <CommitInput
            value={String(settings?.investigationDailyUsd ?? 2)}
            ariaLabel="Daily code check cost limit in US dollars"
            className="w-20"
            onCommit={(value) => {
              const investigationDailyUsd = Number.parseFloat(value);
              if (investigationDailyUsd >= 0) {
                void conductor.updateSettings({ investigationDailyUsd });
              }
            }}
          />
        }
      />
      <CodeCheckFolders />
      <SettingsRow
        label="Safety check"
        description="Confirms code checks cannot read outside your folders or open secret files."
        control={
          <Button variant="text" size="xs" disabled={checking} onClick={recheck}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        }
      />
    </SettingsSection>
  );
});

const LINE_STATE_LABELS = {
  off: 'Off',
  connecting: 'Connecting…',
  open: 'Connected',
  down: 'Not connected',
} as const;

/**
 * The talk line: a realtime voice session that takes the conductor's place while it is open.
 * Experimental and off by default; with it off, nothing here contacts the provider or costs
 * anything.
 */
const TalkLineSettings = observer(function TalkLineSettings() {
  const talk = getTalkStore();
  const status = talk.status;
  const settings = status?.settings ?? null;
  const usage = status?.usageToday;
  const agentId = settings?.agentId.trim() ?? '';
  const voice = settings?.voice ?? '';
  const customVoice = voice && !(TALK_VOICES as readonly string[]).includes(voice) ? voice : '';
  const state = `${LINE_STATE_LABELS[talk.line]}${talk.error ? `: ${talk.error}` : ''}`;
  return (
    <SettingsSection title="Live voice conductor">
      <SettingsRow
        label="Use the live voice conductor"
        description={
          status && !status.hasKey
            ? 'Add an xAI key above so Grok Voice can be the conductor and talk with you live.'
            : `Experimental: Grok Voice hears you and answers aloud, and xAI bills each connected minute. Status: ${state}.`
        }
        control={
          <Switch
            checked={settings?.enabled ?? false}
            disabled={!settings || !status?.hasKey}
            onCheckedChange={(enabled) => void talk.updateSettings({ enabled })}
          />
        }
      />
      <SettingsRow
        label="Custom voice agent"
        description={`The id of a voice agent you built with xAI, used instead of the model and voice below.${agentId && !isTalkAgentId(agentId) ? ' This id is not valid, so live voice will not connect until you fix or clear it.' : ''}`}
        control={
          <CommitInput
            value={agentId}
            ariaLabel="Custom voice agent id"
            placeholder="agent_…"
            className="w-64 font-mono text-xs"
            allowEmpty
            onCommit={(value) => void talk.updateSettings({ agentId: value })}
          />
        }
      />
      <SettingsRow
        label="Voice model"
        description={
          agentId
            ? 'Not used with a custom voice agent.'
            : 'grok-voice-latest moves to each new release; grok-voice-3.0 stays as it is.'
        }
        control={
          <Select.Root
            value={settings?.model ?? ''}
            disabled={!settings || agentId !== ''}
            onValueChange={(model) => {
              if (model) void talk.updateSettings({ model });
            }}
          >
            <Select.Trigger appearance="input" className="w-56">
              <Select.Value>{settings?.model ?? ''}</Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              {TALK_MODELS.map((model) => (
                <Select.Item key={model} value={model}>
                  {model}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        }
      />
      <SettingsRow
        label="Voice"
        description={
          agentId
            ? 'Not used with a custom voice agent.'
            : "Grok's built-in voices, plus your custom voice if you set one below."
        }
        control={
          <Select.Root
            value={voice}
            disabled={!settings || agentId !== ''}
            onValueChange={(voice) => {
              if (voice) void talk.updateSettings({ voice });
            }}
          >
            <Select.Trigger appearance="input" className="w-56">
              <Select.Value>{settings?.voice ?? ''}</Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              {[...TALK_VOICES, ...(customVoice ? [customVoice] : [])].map((option) => (
                <Select.Item key={option} value={option}>
                  {option}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        }
      />
      <SettingsRow
        label="Custom voice"
        description={
          agentId
            ? 'Not used with a custom voice agent.'
            : 'The id of a custom xAI voice, such as a copy of your own voice.'
        }
        control={
          <CommitInput
            value={customVoice}
            ariaLabel="Custom voice id"
            placeholder="Voice id"
            className="w-64 font-mono text-xs"
            allowEmpty
            onCommit={(value) =>
              void talk.updateSettings({
                voice: value.slice(0, 40) || DEFAULT_TALK_SETTINGS.voice,
              })
            }
          />
        }
      />
      <SettingsRow
        layout="stacked"
        label="Voice style"
        description="How the voice should sound, in your own words; it never changes what it does."
        control={
          <Textarea
            key={settings?.voiceStyle ?? ''}
            defaultValue={settings?.voiceStyle ?? ''}
            aria-label="Voice style"
            placeholder="Speak with a laid-back, easygoing vibe…"
            rows={4}
            maxLength={TALK_VOICE_STYLE_MAX_CHARS}
            disabled={!settings}
            className="max-w-xl"
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (settings && next !== settings.voiceStyle) {
                void talk.updateSettings({ voiceStyle: next });
              }
            }}
          />
        }
      />
      <SettingsRow
        label="Web and X search"
        description="Lets the voice look up news and facts on the web and X; xAI bills each search."
        control={
          <Switch
            checked={settings?.webSearch ?? false}
            disabled={!settings}
            onCheckedChange={(webSearch) => void talk.updateSettings({ webSearch })}
          />
        }
      />
      <SettingsRow
        label="Voice effort"
        description={
          agentId
            ? 'Not used with a custom voice agent.'
            : 'High follows longer requests more closely, Off answers sooner, and both cost the same.'
        }
        control={
          <Select.Root
            value={settings?.effort ?? 'high'}
            disabled={!settings || agentId !== ''}
            onValueChange={(effort) => {
              if (effort && isTalkEffort(effort)) void talk.updateSettings({ effort });
            }}
          >
            <Select.Trigger appearance="input" className="w-56">
              <Select.Value>{settings ? TALK_EFFORT_LABELS[settings.effort] : ''}</Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              {Object.entries(TALK_EFFORT_LABELS).map(([id, label]) => (
                <Select.Item key={id} value={id}>
                  {label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        }
      />
      <SettingsRow
        label="Short answers"
        description="The voice answers in a word or a sentence and stays quiet while it works."
        control={
          <Switch
            checked={settings?.replies === 'brief'}
            disabled={!settings}
            onCheckedChange={(brief) =>
              void talk.updateSettings({ replies: brief ? 'brief' : 'normal' })
            }
          />
        }
      />
      <SettingsRow
        label="Listen without the talk key"
        description="Keep the microphone on so Maestro hears everything; best with headphones."
        control={
          <Switch
            checked={settings?.listening === 'open'}
            disabled={!settings}
            onCheckedChange={(open) =>
              void talk.updateSettings({ listening: open ? 'open' : 'key' })
            }
          />
        }
      />
      <SettingsRow
        label="Seconds to reply after Maestro speaks"
        description="Time to answer without the talk key; 0 turns this off."
        control={
          <CommitInput
            value={String(settings?.windowSec ?? 6)}
            ariaLabel="Seconds to reply after Maestro speaks"
            className="w-20"
            onCommit={(value) => {
              const windowSec = Number.parseInt(value, 10);
              if (windowSec >= 0 && windowSec <= 30) void talk.updateSettings({ windowSec });
            }}
          />
        }
      />
      <SettingsRow
        label="Seconds of quiet before disconnecting"
        description="Live voice disconnects after this much quiet to save money; 0 waits up to 15 minutes."
        control={
          <CommitInput
            value={String(settings?.idleSec ?? 20)}
            ariaLabel="Seconds of quiet before disconnecting"
            className="w-20"
            onCommit={(value) => {
              const idleSec = Number.parseInt(value, 10);
              if (idleSec >= 0 && idleSec <= 900) void talk.updateSettings({ idleSec });
            }}
          />
        }
      />
      <SettingsRow
        label="Speak over the voice to stop it"
        description="Keeps the microphone on while the voice talks; best with headphones."
        control={
          <Switch
            checked={settings?.talkOver ?? false}
            disabled={!settings}
            onCheckedChange={(talkOver) => void talk.updateSettings({ talkOver })}
          />
        }
      />
      <SettingsRow
        label="Daily spending limit in US dollars"
        description={
          usage
            ? `Spent today: $${usage.usd.toFixed(2)} over ${Math.round(usage.seconds / 60)} minutes, ${usage.responses} replies and ${usage.sessions} sessions. Grok Voice costs $0.08 a minute; 0 means no limit.`
            : 'Grok Voice costs $0.08 a minute while connected; 0 means no limit.'
        }
        control={
          <CommitInput
            value={String(settings?.dailyUsd ?? 5)}
            ariaLabel="Daily live voice spending limit in US dollars"
            className="w-20"
            onCommit={(value) => {
              const dailyUsd = Number.parseFloat(value);
              if (dailyUsd >= 0 && dailyUsd <= 1000) void talk.updateSettings({ dailyUsd });
            }}
          />
        }
      />
    </SettingsSection>
  );
});

const KeyRow = observer(function KeyRow({
  id,
  label,
  description,
  present,
  onSaved,
}: {
  id: ChorusCredentialId;
  label: string;
  description: string;
  present: boolean | undefined;
  onSaved?: () => void;
}) {
  const voice = getVoiceStore();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (value: string | null) => {
    setSaving(true);
    try {
      await voice.setCredential(id, value);
      setDraft('');
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };
  return (
    // A key is a long value: the field sits under the label and its description at full width,
    // so the description never runs under it. Whether a key is set reads in words.
    <SettingsRow
      layout="stacked"
      label={
        <>
          {label}
          <span
            className={
              present
                ? 'ml-2 text-xs font-normal text-foreground-muted'
                : 'ml-2 text-xs font-normal text-foreground-passive'
            }
          >
            {present ? 'Saved' : 'Not set'}
          </span>
        </>
      }
      description={description}
      control={
        <div className="flex w-full items-center gap-4">
          <div className="max-w-md min-w-0 flex-1">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${label} API key`}
              placeholder={present ? 'Paste a new key to replace it' : 'Paste your key'}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.trim()) void save(draft.trim());
              }}
            />
          </div>
          <Button
            variant="text"
            size="xs"
            disabled={saving || !draft.trim()}
            onClick={() => void save(draft.trim())}
          >
            Save
          </Button>
          {present && (
            <Button variant="text" size="xs" disabled={saving} onClick={() => void save(null)}>
              Remove
            </Button>
          )}
        </div>
      }
    />
  );
});

function CommitInput({
  value,
  ariaLabel,
  placeholder,
  className = 'w-56',
  allowEmpty = false,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  allowEmpty?: boolean;
  onCommit: (value: string) => void;
}) {
  return (
    <Input
      key={value}
      defaultValue={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={className}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if ((next || allowEmpty) && next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function EffortSelect({
  value,
  onChange,
}: {
  value: Effort | undefined;
  onChange: (effort: Effort) => void;
}) {
  return (
    <Select.Root
      value={value ?? 'low'}
      disabled={!value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <Select.Trigger appearance="input" className="w-56">
        <Select.Value>{EFFORT_LABELS[value ?? 'low']}</Select.Value>
      </Select.Trigger>
      <Select.Content align="end">
        {Object.entries(EFFORT_LABELS).map(([id, label]) => (
          <Select.Item key={id} value={id}>
            {label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

const VoicePicker = observer(function VoicePicker() {
  const voice = getVoiceStore();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() =>
    typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices()
  );
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const update = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', update);
    return () => speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  const current = voice.settings?.ttsVoice ?? '';
  return (
    <div className="flex items-center gap-2">
      <Select.Root
        value={current || '__default'}
        onValueChange={(next) => {
          if (next) void voice.updateSettings({ ttsVoice: next === '__default' ? '' : next });
        }}
      >
        <Select.Trigger appearance="input" className="w-56">
          <Select.Value>{current || 'System default'}</Select.Value>
        </Select.Trigger>
        <Select.Content align="end">
          <Select.Item value="__default">System default</Select.Item>
          {voices.map((option) => (
            <Select.Item key={option.voiceURI} value={option.name}>
              {option.name}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <Button variant="text" size="xs" onClick={() => voice.speech.speak('Maestro is listening.')}>
        Test
      </Button>
    </div>
  );
});

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tokens`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k tokens`;
  return `${count} tokens`;
}

/** The short worktree folder Chorus suggests on Windows (under the user profile). */
const SHORT_WORKTREE_ROOT = '~\\chorus\\wt';

/**
 * Windows settings that commonly break or slow down agent worktrees: git long paths (one-click
 * fix), a short worktree folder (one click, host setting), and a Defender exclusion (a guide and
 * a command to copy; Chorus never changes security settings itself).
 */
function WindowsChecks() {
  const [checks, setChecks] = useState<SystemChecks | null>(null);
  const [fixing, setFixing] = useState(false);
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void getConductorClient()
      .then((client) => client.getSystemChecks())
      .then(setChecks)
      .catch(() => setChecks(null));
  }, []);
  if (!checks || checks.platform !== 'win32') return null;
  const exclusionPath = worktreeRoot ?? '$env:USERPROFILE\\chorus\\wt';
  const defenderCommand = `Add-MpPreference -ExclusionPath "${exclusionPath}"`;

  return (
    <SettingsSection title="Windows">
      {(!checks.git || !checks.longPaths) && (
        <SettingsRow
          label={checks.git ? 'Long file paths are off in Git' : 'Git was not found'}
          description={
            checks.git
              ? 'Turn them on so agents can work in projects with deeply nested folders.'
              : 'Install Git for Windows, then restart Maestro.'
          }
          control={
            checks.git ? (
              <Button
                variant="primary"
                size="sm"
                disabled={fixing}
                onClick={() => {
                  setFixing(true);
                  void getConductorClient()
                    .then((client) => client.enableGitLongPaths())
                    .then(setChecks)
                    .finally(() => setFixing(false));
                }}
              >
                Turn on long paths
              </Button>
            ) : null
          }
        />
      )}
      <SettingsRow
        label="Short worktree folder"
        description={
          worktreeRoot
            ? `New agent worktrees go to ${worktreeRoot}; you can change this under Machines.`
            : 'Put new agent worktrees in a short folder to stay within Windows path limits.'
        }
        control={
          worktreeRoot ? null : (
            <Button
              variant="text"
              size="xs"
              onClick={() => {
                void getMachinesClient()
                  .then((client) =>
                    client.updateHostSettings({
                      machineId: undefined,
                      patch: { worktreeRoot: SHORT_WORKTREE_ROOT },
                    })
                  )
                  .then((result) => {
                    if (result.success) {
                      setWorktreeRoot(result.data.settings.worktreeRoot ?? SHORT_WORKTREE_ROOT);
                    }
                  });
              }}
            >
              Use {SHORT_WORKTREE_ROOT}
            </Button>
          )
        }
      />
      <SettingsRow
        label="Faster worktrees with Defender"
        description={
          <>
            Virus scans slow agents down; to skip their folder, run this in PowerShell as
            administrator:{' '}
            <code className="rounded-xs bg-surface-hover px-1 font-mono break-words">
              {defenderCommand}
            </code>
            . Maestro never changes this for you.
          </>
        }
        control={
          <Button
            variant="text"
            size="xs"
            onClick={() => {
              void copyTextToClipboard(defenderCommand).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </Button>
        }
      />
    </SettingsSection>
  );
}

const CanvasSettings = observer(function CanvasSettings() {
  const canvas = getCanvasStore();
  return (
    <>
      <SettingsRow
        label="Open on the canvas"
        description="Start Maestro on the canvas instead of the last view you had open."
        control={
          <Switch
            checked={canvas.openOnLaunch}
            onCheckedChange={(next) => canvas.setOpenOnLaunch(next)}
          />
        }
      />
      <SettingsRow
        label="Task frames"
        description="Group each task's agents in a frame that shows its changes and a review button."
        control={
          <Switch
            checked={canvas.showTaskFrames}
            onCheckedChange={(next) => canvas.setShowTaskFrames(next)}
          />
        }
      />
      <SettingsRow
        label="Show names while listening"
        description="Show each window's name in large type while the microphone is on."
        control={
          <Switch
            checked={canvas.layoutSettings.showNamesWhileListening}
            onCheckedChange={(next) => canvas.setLayoutSettings({ showNamesWhileListening: next })}
          />
        }
      />
      <SettingsRow
        label="Confirm layout changes aloud"
        description="After you arrange windows by voice, say what changed, like “Grouped Atlas and Bravo”."
        control={
          <Switch
            checked={canvas.layoutSettings.speakLayoutConfirmations}
            onCheckedChange={(next) => canvas.setLayoutSettings({ speakLayoutConfirmations: next })}
          />
        }
      />
      <SettingsRow
        label="Open new windows in their project's region"
        description="New agents and browsers go to a region named after their project."
        control={
          <Switch
            checked={canvas.layoutSettings.placeNewWindowsInProjectRegion}
            onCheckedChange={(next) =>
              canvas.setLayoutSettings({ placeNewWindowsInProjectRegion: next })
            }
          />
        }
      />
      <SettingsRow
        label="One desk per project in Canvas Pro"
        description="In Canvas Pro, new agents and browsers go to a desk named after their project."
        control={
          <Switch
            checked={canvas.layoutSettings.placeNewWindowsOnProjectDesk}
            onCheckedChange={(next) =>
              canvas.setLayoutSettings({ placeNewWindowsOnProjectDesk: next })
            }
          />
        }
      />
      <SettingsRow
        label="Group a plan's agents"
        description="Put the agents a plan starts into one region named after the plan."
        control={
          <Switch
            checked={canvas.layoutSettings.groupPlanAgents}
            onCheckedChange={(next) => canvas.setLayoutSettings({ groupPlanAgents: next })}
          />
        }
      />
      <SettingsRow
        label="New windows join the region in view"
        description="New agents and browsers open in the region you are looking at."
        control={
          <Switch
            checked={canvas.layoutSettings.placeNewAgentsInCurrentRegion}
            onCheckedChange={(next) =>
              canvas.setLayoutSettings({ placeNewAgentsInCurrentRegion: next })
            }
          />
        }
      />
    </>
  );
});
