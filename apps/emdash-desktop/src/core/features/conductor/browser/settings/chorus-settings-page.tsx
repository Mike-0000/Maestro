import { PageLayout, SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Input, Select, Switch } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { TALK_MODELS } from '@core/features/talk/api/usage';
import { getTalkStore } from '@core/features/talk/contributions/browser/app-stores';
import {
  acceleratorFromCodes,
  acceleratorLabel,
  HOLD_KEY_OFF,
  holdComboFromCodes,
  holdComboLabel,
} from '@core/features/voice/api/global-keys';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import { copyTextToClipboard } from '@core/primitives/desktop-host/browser/host-client';
import { getConductorClient } from '../../api/browser/client';
import { CODE_CHECKS_UI, type SystemChecks } from '../../api/contract';
import { STANDING_LIMITS, type InstructionChange } from '../../api/standing-instructions';
import { getConductorStore } from '../../contributions/browser/app-stores';
import { KeyCaptureControl } from './key-capture-control';

function DiagnosticControls({ enabled }: { enabled: boolean }) {
  const conductor = getConductorStore();
  const [message, setMessage] = useState('');
  return (
    <div className="flex items-center gap-2 text-xs">
      <Button
        variant="secondary"
        size="xs"
        disabled={!enabled}
        onClick={() => {
          if (
            !window.confirm(
              'Copy up to 200 recent redacted diagnostic events to the clipboard? Only share them with an agent you trust.'
            )
          )
            return;
          void (async () => {
            try {
              const events = await conductor.recentTrace();
              await copyTextToClipboard(events.map((event) => JSON.stringify(event)).join('\n'));
              setMessage(
                `Copied ${events.length} events. Paste into a trusted coding agent to inspect them.`
              );
            } catch {
              setMessage('Could not copy diagnostic events.');
            }
          })();
        }}
      >
        Copy recent events for agent
      </Button>
      <Button
        variant="secondary"
        size="xs"
        onClick={() => {
          if (
            !window.confirm(
              'Permanently delete all local Maestro command logs and diagnostic traces?'
            )
          )
            return;
          void (async () => {
            try {
              await (await getConductorClient()).deleteDiagnostics();
              setMessage('Diagnostics deleted.');
            } catch {
              setMessage('Could not delete diagnostics.');
            }
          })();
        }}
      >
        Delete diagnostics
      </Button>
      <span role="status">{message}</span>
    </div>
  );
}

const ENGINE_LABELS = {
  openai: 'OpenAI (gpt-4o-transcribe)',
  deepgram: 'Deepgram (Nova-3)',
  'whisper-local': 'Local whisper.cpp server',
  openrouter: 'OpenRouter (audio model)',
} as const;

const TTS_ENGINE_LABELS = {
  platform: 'Windows (offline)',
  kitten: 'Kitten Mini (offline)',
  'gemini-flash': 'Gemini 3.8 Flash (quality)',
  'gemini-flash-lite': 'Gemini 3.8 Flash-Lite (fast)',
  'openrouter-gemini-flash': 'Gemini 3.8 Flash via OpenRouter',
  'openrouter-gemini-flash-lite': 'Gemini 3.8 Flash-Lite via OpenRouter',
} as const;
type TtsEngine = keyof typeof TTS_ENGINE_LABELS;

function isTtsEngine(value: unknown): value is TtsEngine {
  return typeof value === 'string' && value in TTS_ENGINE_LABELS;
}

/** Cloud engines speak with Gemini's prebuilt voices, whichever key they use. */
function usesGeminiVoice(engine: TtsEngine | undefined): boolean {
  return engine !== undefined && engine !== 'platform' && engine !== 'kitten';
}

const JEV_SOURCE_LABELS = {
  auto: 'Auto',
  openrouter: 'OpenRouter',
  typesafe: 'TypeSafe',
} as const;

const CALL_MODE_LABELS = {
  off: 'Off',
  quiet: 'Shown',
  spoken: 'Spoken',
} as const;

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
} as const;

type Effort = keyof typeof EFFORT_LABELS;

/** The efforts offered for the voice line's realtime model. */
const TALK_EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const;

type TalkEffort = keyof typeof TALK_EFFORT_LABELS;

export const ChorusSettingsPage = observer(function ChorusSettingsPage() {
  const voice = getVoiceStore();
  const conductor = getConductorStore();
  useEffect(() => {
    void voice.refreshStatus();
    void conductor.refreshStatus();
  }, [voice, conductor]);

  const voiceSettings = voice.settings;
  const conductorSettings = conductor.settings;
  const credentials = voice.status?.credentials;

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Voice & Conductor"
        description="Talk to your agents. Keys are encrypted with Windows DPAPI and never leave the main process."
      />

      <WindowsChecks />

      <SettingsSection title="Diagnostic history">
        <SettingsRow
          label="Record voice interaction traces"
          description="Off by default. Stores redacted transcripts, commands, tool arguments and replies locally. May still contain private information. Turning off deletes stored diagnostics."
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
          label="Retain for days"
          description="At most 30 days and 2 MB per diagnostic file."
          control={
            <CommitInput
              value={String(conductorSettings?.diagnosticDays ?? 7)}
              ariaLabel="Diagnostic retention days"
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
          description="One OpenRouter key runs the conductor, speech-to-text, and Jev."
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
                void conductor.updateSettings({ jevSource: useOpenRouter ? 'openrouter' : 'auto' });
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="API keys">
        <KeyRow
          id="anthropic"
          label="Anthropic"
          description="Powers the conductor. Built-in commands work without it."
          present={credentials?.anthropic}
          onSaved={() => void conductor.refreshStatus()}
        />
        <KeyRow
          id="openrouter"
          label="OpenRouter"
          description="Runs the conductor, speech-to-text, Jev, and optional Gemini speech output through OpenRouter."
          present={credentials?.openrouter}
          onSaved={() => void conductor.refreshStatus()}
        />
        <KeyRow
          id="typesafe"
          label="TypeSafe (Jev)"
          description="Optional: call Jev directly on TypeSafe. Not needed if you use OpenRouter."
          present={credentials?.typesafe}
          onSaved={() => void conductor.refreshStatus()}
        />
        <KeyRow
          id="openai"
          label="OpenAI"
          description="Speech-to-text with gpt-4o-transcribe."
          present={credentials?.openai}
        />
        <KeyRow
          id="deepgram"
          label="Deepgram"
          description="Speech-to-text with Nova-3 and keyterm boosting for agent names."
          present={credentials?.deepgram}
        />
        <KeyRow
          id="gemini"
          label="Google Gemini"
          description="Optional cloud text-to-speech. Spoken replies are sent to Google and billed by audio duration. GEMINI_API_KEY also works."
          present={credentials?.gemini}
        />
      </SettingsSection>

      <SettingsSection title="Canvas">
        <CanvasSettings />
      </SettingsSection>

      <SettingsSection title="Voice">
        <SettingsRow
          label="Speech-to-text engine"
          description="Local whisper.cpp keeps audio on this machine; see docs/chorus/voice.md to set it up."
          control={
            <Select.Root
              value={voiceSettings?.engine ?? 'openai'}
              disabled={!voiceSettings}
              onValueChange={(engine) => {
                if (engine) void voice.updateSettings({ engine });
              }}
            >
              <Select.Trigger className="w-[230px]">
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
        {voiceSettings?.engine === 'whisper-local' && (
          <SettingsRow
            label="whisper-server URL"
            description="Address of a running whisper.cpp server (the /inference endpoint is used)."
            control={
              <CommitInput
                value={voiceSettings.whisperUrl}
                ariaLabel="whisper-server URL"
                onCommit={(whisperUrl) => void voice.updateSettings({ whisperUrl })}
              />
            }
          />
        )}
        {voiceSettings?.engine === 'openrouter' && (
          <SettingsRow
            label="OpenRouter speech model"
            description="Any OpenRouter model that accepts audio input, e.g. google/gemini-3.5-flash-lite or openai/gpt-audio-mini."
            control={
              <CommitInput
                value={voiceSettings.openrouterSttModel}
                ariaLabel="OpenRouter speech model"
                onCommit={(openrouterSttModel) => void voice.updateSettings({ openrouterSttModel })}
              />
            }
          />
        )}
        <SettingsRow
          label="Language"
          description="ISO code of the language you speak, e.g. en, de, fr."
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
              ? 'The system keyboard hook could not start; hold-to-talk works only inside Maestro.'
              : 'Click, then press the key or keys to use in any app. Hold to talk and release to send, or double-tap to keep listening and tap once more to send. Off: hold-to-talk works only inside Maestro. Maestro only watches for these keys; it never records what you type.'
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
          label="Global talk shortcut"
          description={
            voiceSettings?.globalShortcut && voice.status && !voice.status.globalShortcutRegistered
              ? 'Windows would not register this shortcut: another app owns it, or the key cannot be a global shortcut. Record a different one.'
              : 'Toggles listening from anywhere in Windows. Click, then press a key or a combination such as Num Lock or Ctrl + Alt + Space. In the app you can also hold Right Ctrl.'
          }
          control={
            <KeyCaptureControl
              label={
                voiceSettings?.globalShortcut
                  ? acceleratorLabel(voiceSettings.globalShortcut)
                  : null
              }
              ariaLabel="Global talk shortcut"
              disabled={!voiceSettings}
              resolve={acceleratorFromCodes}
              onCommit={(globalShortcut) => void voice.updateSettings({ globalShortcut })}
              onClear={() => void voice.updateSettings({ globalShortcut: '' })}
            />
          }
        />
        <SettingsRow
          label="Live transcript"
          description="Stream audio while you speak and show words as they are recognized (Deepgram)."
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
          description="Keep listening and start on speech. Only utterances that begin with the wake phrase are acted on; every utterance is transcribed, so this uses more STT."
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
            description="Say it first: “Maestro, focus Claude 1”. Leave empty to act on everything (not recommended)."
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
          label="Spoken output"
          description={
            voiceSettings?.ttsEngine.startsWith('openrouter-') && !credentials?.openrouter
              ? 'Add an OpenRouter API key above; until then, replies use the Windows voice.'
              : 'Kitten Mini runs offline on your CPU; Gemini (direct or via OpenRouter) sends reply text to Google. Windows speech is the fallback.'
          }
          control={
            <Select.Root
              value={voiceSettings?.ttsEngine ?? 'platform'}
              disabled={!voiceSettings}
              onValueChange={(engine) => {
                if (isTtsEngine(engine)) void voice.updateSettings({ ttsEngine: engine });
              }}
            >
              <Select.Trigger className="w-[280px]">
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
            label="Local voice"
            description="An English voice from the bundled Kitten Mini model; no account or download needed."
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
                <Select.Trigger className="w-[230px]">
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
            description="A prebuilt English voice for spoken replies and notifications."
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
                <Select.Trigger className="w-[230px]">
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
        <SettingsRow
          label="Windows fallback voice"
          description="Used if the selected model fails. Test previews the selected output engine."
          control={<VoicePicker />}
        />
      </SettingsSection>

      <SettingsSection title="Conductor">
        <SettingsRow
          label="Conductor provider"
          description="Call Claude directly with an Anthropic key, or any tool-capable model through OpenRouter."
          control={
            <Select.Root
              value={conductorSettings?.provider ?? 'anthropic'}
              disabled={!conductorSettings}
              onValueChange={(provider) => {
                if (provider) void conductor.updateSettings({ provider });
              }}
            >
              <Select.Trigger className="w-[180px]">
                <Select.Value>
                  {conductorSettings?.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic API'}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                <Select.Item value="anthropic">Anthropic API</Select.Item>
                <Select.Item value="openrouter">OpenRouter</Select.Item>
              </Select.Content>
            </Select.Root>
          }
        />
        {conductorSettings?.provider === 'openrouter' ? (
          <SettingsRow
            label="OpenRouter model"
            description="Model id on OpenRouter; it must support tool calling."
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
            label="Model"
            description="Claude model that plans and routes your commands."
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
          label="Command effort"
          description="Reasoning effort for quick commands. Lower is faster."
          control={
            <EffortSelect
              value={conductorSettings?.commandEffort}
              onChange={(commandEffort) => void conductor.updateSettings({ commandEffort })}
            />
          }
        />
        <SettingsRow
          label="Planning effort"
          description="Reasoning effort when splitting a goal across several agents."
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
          label="Use Jev for fast decisions"
          description={
            conductor.status?.jevReady
              ? `On, via ${conductor.status.jevVia === 'openrouter' ? 'OpenRouter' : 'TypeSafe'}: routing, permission risk, attention order, and plan review use Jev.`
              : conductorSettings?.jevEnabled === false
                ? 'Off.'
                : 'Add an OpenRouter (or TypeSafe) API key above to enable.'
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
          label="Jev source"
          description="Where Jev runs. Auto uses whichever key is set, preferring OpenRouter when the conductor uses it."
          control={
            <Select.Root
              value={conductorSettings?.jevSource ?? 'auto'}
              disabled={!conductorSettings}
              onValueChange={(jevSource) => {
                if (jevSource) void conductor.updateSettings({ jevSource });
              }}
            >
              <Select.Trigger className="w-[160px]">
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
          label="Jev confidence to act"
          description="Jev acts on its own only above this confidence; below it, Claude decides. Showing windows needs 0.1 less; sending messages and starting agents needs 0.05 more."
          control={
            <CommitInput
              value={String(conductorSettings?.jevConfidence ?? 0.8)}
              ariaLabel="Jev confidence to act"
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
          label="Fast verbatim routing"
          description="When Jev is confident, it sends your own words to an agent or starts a new agent itself instead of Claude rewriting your request. Off: Claude writes every message and starts every agent."
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
          description="Spawn planned agents immediately instead of waiting for your yes."
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
          description="When an agent finishes, the conductor reads its final reply to tell you what it did (say, the URL of the app it started) and to do follow-ups you asked for, such as opening that app. With Jev, clear results are read out in the agent's own words and progress notes with nothing new stay on screen; Claude only handles the rest. Off: a short fixed announcement."
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
          description="When an agent ends a turn, the conductor's model reads its final reply and decides whether the agent is waiting for you or is done. An agent that ends on a question it cannot go on without shows as Needs you at once; one that only offers next steps shows as Done and stays that way. Permission prompts are not affected. Off, or when the model cannot be reached: the agent's own events decide."
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
          label="Let agents ask the conductor"
          description="Claude Code and Codex agents on this computer can ask the conductor to start another agent, pass a message to one, ask you a question, or tell you something by voice. The conductor decides requests to start or message an agent, or asks you when it is unsure; you can cancel each one as it starts. Off: every request is refused."
          control={
            <Switch
              checked={conductorSettings?.agentRequests ?? true}
              disabled={!conductorSettings}
              onCheckedChange={(agentRequests) => void conductor.updateSettings({ agentRequests })}
            />
          }
        />
        <SettingsRow
          label="Calls from agents"
          description="Agents reach you one at a time. While one is on the line, tap Right Ctrl (or hold it, or press Answer) and what you say goes to that agent without naming it. Confirmations are read aloud, and so are sends when you answered a call or Maestro is not in front. Spoken reads each call out; Shown only displays it. Off: one combined announcement, as before."
          control={
            <Select.Root
              value={conductorSettings?.calls ?? 'off'}
              disabled={!conductorSettings}
              onValueChange={(calls) => {
                if (calls) void conductor.updateSettings({ calls });
              }}
            >
              <Select.Trigger className="w-[160px]">
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
          description="How long you have to pick a call up after it was delivered (2 to 30). After that the next call comes, and the agent still shows as waiting."
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
          label="Daily token budget"
          description={
            conductor.status
              ? `Used today: ${formatTokens(conductor.status.usageToday.inputTokens + conductor.status.usageToday.outputTokens)} (${formatTokens(conductor.status.usageToday.cacheReadTokens)} cached). 0 disables the limit.`
              : '0 disables the limit.'
          }
          control={
            <CommitInput
              value={String(conductorSettings?.dailyTokenBudget ?? 0)}
              ariaLabel="Daily token budget"
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
          description="The conductor remembers the last few exchanges. Clear it to start fresh."
          control={
            <Button variant="secondary" size="xs" onClick={() => conductor.clearHistory()}>
              Clear
            </Button>
          }
        />
      </SettingsSection>

      <StandingInstructionSettings />

      <TalkLineSettings />

      {CODE_CHECKS_UI && <CodeCheckSettings />}
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
        label="How the conductor should act from now on"
        description={`Say it to the conductor ("from now on, keep your prompts short and open-ended") and it saves the instruction here, or type one. They shape how it words prompts and replies and which defaults it picks, in every session; they never change what Maestro asks you to confirm. ${saved.length} of ${STANDING_LIMITS.entries} saved.${message ? ` ${message}` : ''}`}
        control={
          <CommitInput
            // A new field once one is saved, so what was typed does not stay in it.
            key={saved.length}
            value=""
            ariaLabel="New standing instruction"
            placeholder="Add an instruction…"
            className="w-72"
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
              variant="secondary"
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

const INVESTIGATOR_MODELS = { haiku: 'Haiku (fast, cheap)', sonnet: 'Sonnet' } as const;

/**
 * Code checks: a read-only Claude Code process that answers the conductor's questions about a
 * project's files. Hidden until the gates in docs/conductor-subagent-plan.md pass.
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
        ? `Unavailable: ${investigator.reason ?? 'unknown reason'}.`
        : 'Off.';
  const model = settings?.investigatorModel ?? 'haiku';
  return (
    <SettingsSection title="Code checks">
      <SettingsRow
        label="Let the conductor read project files"
        description={`Lets the conductor read a project's files through Claude Code, read-only, to check facts before it plans. File contents go to Anthropic through your Claude Code login. A short self-test runs when you turn this on and after Claude Code updates. ${state}`}
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
        description="Haiku answered every test question correctly in 9 to 13 seconds."
        control={
          <Select.Root
            value={model}
            disabled={!settings}
            onValueChange={(investigatorModel) => {
              if (investigatorModel) void conductor.updateSettings({ investigatorModel });
            }}
          >
            <Select.Trigger className="w-[180px]">
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
        description="15 to 60. A check that runs longer is stopped."
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
            ? `Asked today: ${status.usageToday.investigations ?? 0}, about $${(status.usageToday.investigationCostUsd ?? 0).toFixed(2)}. 0 is no limit.`
            : '0 is no limit.'
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
        label="Daily cost limit (US dollars)"
        description="What code checks may cost in a day, as Claude Code reports it. 0 is no limit."
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
      <SettingsRow
        label="Check Claude Code again"
        description="Runs the self-test: that the scout cannot read outside the project, cannot read secret files, and runs no project hooks."
        control={
          <Button variant="secondary" size="xs" disabled={checking} onClick={recheck}>
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
  open: 'Open',
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
  const state = `${LINE_STATE_LABELS[talk.line]}${talk.error ? `: ${talk.error}` : ''}`;
  return (
    <SettingsSection title="Realtime voice conductor (experimental)">
      <SettingsRow
        label="Use a realtime voice model as the conductor"
        description={
          status && !status.hasKey
            ? 'Needs an OpenAI API key (API keys, above). While it is on, a realtime voice model is the conductor: it hears you directly, answers aloud, and messages, starts and manages agents itself. Confirmations stay as they are.'
            : `While it is on, a realtime voice model is the conductor: it hears you directly, answers aloud, and messages, starts and manages agents itself. Confirmations stay as they are, and typed commands go to it too. If the line is down or over its limit, the text conductor answers. Audio and the state it is told go to OpenAI while the line is open. Line: ${state}.`
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
        label="Voice model"
        description="The full model reads state more reliably; mini costs about a quarter. Changing it reopens the line."
        control={
          <Select.Root
            value={settings?.model ?? ''}
            disabled={!settings}
            onValueChange={(model) => {
              if (model) void talk.updateSettings({ model });
            }}
          >
            <Select.Trigger className="w-[220px]">
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
        label="Voice effort"
        description="How much the voice model reasons before it answers. Higher follows instructions more closely; lower answers sooner and costs less. Changing it reopens the line."
        control={
          <Select.Root
            value={settings?.effort ?? 'low'}
            disabled={!settings}
            onValueChange={(effort) => {
              if (effort) void talk.updateSettings({ effort });
            }}
          >
            <Select.Trigger className="w-[140px]">
              <Select.Value>
                {settings ? (TALK_EFFORT_LABELS[settings.effort as TalkEffort] ?? 'Minimal') : ''}
              </Select.Value>
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
        description="On: the voice confirms what it did in a word or two, answers a question in one sentence, and says nothing while it works. A failure, a cancel, or a question it needs answered is still said. Off: it takes a sentence or two. Changing it reopens the line."
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
        description="Off: Maestro hears you while you hold the talk key, and for a moment after it speaks. On: the microphone stays open and Maestro answers whatever you say to it. Best with headphones, or in a quiet room."
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
        label="Seconds the microphone stays open after Maestro speaks"
        description="So an answer or a follow-up needs no key. What you say in it is acted on like anything else. 0 never opens the microphone without the talk key. Not used when Maestro listens without the key."
        control={
          <CommitInput
            value={String(settings?.windowSec ?? 6)}
            ariaLabel="Seconds the microphone stays open after Maestro speaks"
            className="w-20"
            onCommit={(value) => {
              const windowSec = Number.parseInt(value, 10);
              if (windowSec >= 0 && windowSec <= 30) void talk.updateSettings({ windowSec });
            }}
          />
        }
      />
      <SettingsRow
        label="Speak over the voice to stop it"
        description="Keeps the microphone open while the voice is speaking. Turn it on with headphones, or if this computer's echo cancellation keeps the voice out of the microphone; otherwise the voice may stop itself. Off: the talk key stops it."
        control={
          <Switch
            checked={settings?.talkOver ?? false}
            disabled={!settings}
            onCheckedChange={(talkOver) => void talk.updateSettings({ talkOver })}
          />
        }
      />
      <SettingsRow
        label="Daily limit (US dollars)"
        description={
          usage
            ? `Spent today: $${usage.usd.toFixed(2)} over ${usage.responses} responses and ${usage.sessions} sessions. At the limit the line closes until tomorrow and the text conductor takes over. 0 is no limit.`
            : '0 is no limit.'
        }
        control={
          <CommitInput
            value={String(settings?.dailyUsd ?? 5)}
            ariaLabel="Daily limit in US dollars"
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
    <SettingsRow
      label={
        <>
          {label}
          <span
            className={
              present
                ? 'ml-2 text-xs font-normal text-green-700 dark:text-green-400'
                : 'ml-2 text-xs font-normal text-foreground-muted'
            }
          >
            {present ? 'Configured' : 'Not set'}
          </span>
        </>
      }
      description={description}
      control={
        <div className="flex items-center gap-2">
          <div className="w-56 shrink-0">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${label} API key`}
              placeholder={present ? '••••••••  (replace)' : 'Paste API key'}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.trim()) void save(draft.trim());
              }}
            />
          </div>
          <Button
            variant="secondary"
            size="xs"
            disabled={saving || !draft.trim()}
            onClick={() => void save(draft.trim())}
          >
            Save
          </Button>
          {present && (
            <Button variant="ghost" size="xs" disabled={saving} onClick={() => void save(null)}>
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
      <Select.Trigger className="w-[140px]">
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
        <Select.Trigger className="w-[230px]">
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
      <Button variant="ghost" size="xs" onClick={() => voice.speech.speak('Maestro is listening.')}>
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
          label={checks.git ? 'Git long paths are off' : 'Git was not found'}
          description={
            checks.git
              ? 'Agent worktrees nest deep folders (node_modules). With long paths off, checkouts fail past 260 characters. This sets git config --global core.longpaths true.'
              : 'Install Git for Windows and restart Maestro; agents work in git worktrees.'
          }
          control={
            checks.git ? (
              <Button
                variant="primary"
                size="xs"
                disabled={fixing}
                onClick={() => {
                  setFixing(true);
                  void getConductorClient()
                    .then((client) => client.enableGitLongPaths())
                    .then(setChecks)
                    .finally(() => setFixing(false));
                }}
              >
                Enable long paths
              </Button>
            ) : null
          }
        />
      )}
      <SettingsRow
        label="Short worktree folder"
        description={
          worktreeRoot
            ? `New agent worktrees go to ${worktreeRoot}. Change it any time under Machines.`
            : 'Deep paths hit Windows limits. Put new agent worktrees in a short folder under your profile (existing tasks stay where they are).'
        }
        control={
          worktreeRoot ? null : (
            <Button
              variant="secondary"
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
        description={`Real-time scanning slows worktree creation and installs. To exclude the worktree folder, run this in an administrator PowerShell: ${defenderCommand}. Maestro never changes security settings for you.`}
        control={
          <Button
            variant="ghost"
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
        description="Start Maestro on the agent canvas instead of the last view you had open."
        control={
          <Switch
            checked={canvas.openOnLaunch}
            onCheckedChange={(next) => canvas.setOpenOnLaunch(next)}
          />
        }
      />
      <SettingsRow
        label="Task frames"
        description="Group each task's agents in a frame showing its diff size and a shortcut to review changes."
        control={
          <Switch
            checked={canvas.showTaskFrames}
            onCheckedChange={(next) => canvas.setShowTaskFrames(next)}
          />
        }
      />
      <SettingsRow
        label="Show names while listening"
        description="Show each window's spoken name in large type while the microphone is open."
        control={
          <Switch
            checked={canvas.layoutSettings.showNamesWhileListening}
            onCheckedChange={(next) => canvas.setLayoutSettings({ showNamesWhileListening: next })}
          />
        }
      />
      <SettingsRow
        label="Speak layout confirmations"
        description='Say "Grouped Atlas and Bravo into Review" out loud after spoken layout changes. Off: changes are shown, and only failures and questions are spoken.'
        control={
          <Switch
            checked={canvas.layoutSettings.speakLayoutConfirmations}
            onCheckedChange={(next) => canvas.setLayoutSettings({ speakLayoutConfirmations: next })}
          />
        }
      />
      <SettingsRow
        label="Spawn windows in a project sub-canvas"
        description="New agents and app browsers open in that project's main sub-canvas. If none exists yet, one is created and named after the project. Turn off to place them on the board."
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
        label="Group plan agents"
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
        description="When you are zoomed into a region or have it on the stage, new agents and app browsers go there instead of the project's main sub-canvas."
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
