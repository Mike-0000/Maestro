import { PageLayout, SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Input, Select, Switch } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import { getConductorClient } from '../../api/browser/client';
import type { SystemChecks } from '../../api/contract';
import { getConductorStore } from '../../contributions/browser/app-stores';

const ENGINE_LABELS = {
  openai: 'OpenAI (gpt-4o-transcribe)',
  deepgram: 'Deepgram (Nova-3)',
  'whisper-local': 'Local whisper.cpp server',
} as const;

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
} as const;

type Effort = keyof typeof EFFORT_LABELS;

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

      <SettingsSection title="API keys">
        <KeyRow
          id="anthropic"
          label="Anthropic"
          description="Powers the conductor. Built-in commands work without it."
          present={credentials?.anthropic}
          onSaved={() => void conductor.refreshStatus()}
        />
        <KeyRow
          id="typesafe"
          label="TypeSafe (Jev)"
          description="Fast typed decisions: routes commands without Claude, rates permission risk, ranks who needs you, and reviews plans."
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
          label="Global talk shortcut"
          description={
            voice.status && !voice.status.globalShortcutRegistered
              ? 'Another app owns this shortcut. Pick a different one.'
              : 'Toggles listening from anywhere in Windows. In the app you can also hold Right Ctrl.'
          }
          control={
            <CommitInput
              value={voiceSettings?.globalShortcut ?? ''}
              ariaLabel="Global talk shortcut"
              placeholder="Control+Alt+Space"
              onCommit={(globalShortcut) => void voice.updateSettings({ globalShortcut })}
            />
          }
        />
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
          label="Voice"
          description="Windows text-to-speech voice for replies."
          control={<VoicePicker />}
        />
      </SettingsSection>

      <SettingsSection title="Conductor">
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
              ? 'On: routing, permission risk, attention order, and plan review use Jev.'
              : credentials?.typesafe
                ? 'Off.'
                : 'Add a TypeSafe API key above to enable.'
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
          label="Jev confidence to act"
          description="Jev acts on its own only above this confidence; below it, Claude decides."
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
    </div>
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
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
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
        if (next && next !== value) onCommit(next);
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
      <Button variant="ghost" size="xs" onClick={() => voice.speech.speak('Chorus is listening.')}>
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

/** Surfaces Windows settings that break agent worktrees, with a one-click fix. */
function WindowsChecks() {
  const [checks, setChecks] = useState<SystemChecks | null>(null);
  const [fixing, setFixing] = useState(false);
  useEffect(() => {
    void getConductorClient()
      .then((client) => client.getSystemChecks())
      .then(setChecks)
      .catch(() => setChecks(null));
  }, []);
  if (!checks || checks.platform !== 'win32' || (checks.git && checks.longPaths)) return null;
  return (
    <SettingsSection title="Windows">
      <SettingsRow
        label={checks.git ? 'Git long paths are off' : 'Git was not found'}
        description={
          checks.git
            ? 'Agent worktrees nest deep folders (node_modules). With long paths off, checkouts fail past 260 characters. This sets git config --global core.longpaths true.'
            : 'Install Git for Windows and restart Chorus; agents work in git worktrees.'
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
    </SettingsSection>
  );
}

const CanvasSettings = observer(function CanvasSettings() {
  const canvas = getCanvasStore();
  return (
    <>
      <SettingsRow
        label="Open on the canvas"
        description="Start Chorus on the agent canvas instead of the last view you had open."
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
    </>
  );
});
