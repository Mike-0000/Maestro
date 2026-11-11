import { Button, DropdownMenu } from '@emdash/ui/react/primitives';
import { Headphones } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  getAudioDevices,
  type AudioDeviceChoice,
  type AudioDeviceOption,
} from '@core/features/voice/api/browser/audio-devices';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import { detectPlatformContext } from '@core/primitives/keybindings/api/chord';

/** The radio value of "System default"; Chromium's own ids are hashes, never this. */
const SYSTEM_DEFAULT = '__system-default__';

const isWindows = detectPlatformContext().os === 'windows';

/**
 * The voice bar's quick pick of microphone and speaker: any device this computer has, or the
 * Windows default (which follows Windows as it changes). Windows only for now.
 */
export const AudioDeviceMenu = observer(function AudioDeviceMenu() {
  if (!isWindows) return null;
  return <AudioDeviceMenuInner />;
});

const AudioDeviceMenuInner = observer(function AudioDeviceMenuInner() {
  const devices = getAudioDevices();
  const voice = getVoiceStore();
  const microphone = describe(devices.input, devices.inputMissing, devices.defaultInputLabel);
  const speaker = describe(devices.output, devices.outputMissing, devices.defaultOutputLabel);
  const label = `Microphone: ${microphone} · Speaker: ${speaker}`;
  const systemVoice = voice.settings?.ttsEngine === 'platform';
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        // Names appear once the microphone has been allowed; read them fresh on every open.
        if (open) void devices.refresh();
      }}
    >
      {/* The bar's quiet glyph button, like its neighbours; the devices in use are its title. */}
      <DropdownMenu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="base"
            icon
            aria-label={`Audio devices. ${label}`}
            title={label}
          />
        }
      >
        <Headphones aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="top"
        align="end"
        sideOffset={12}
        width="content"
        className="max-w-90"
      >
        <DeviceGroup
          title="Microphone"
          choice={devices.input}
          options={devices.inputs}
          missing={devices.inputMissing}
          defaultLabel={devices.defaultInputLabel}
          onChoose={(choice) => devices.setInput(choice)}
        />
        <DropdownMenu.Separator />
        <DeviceGroup
          title="Speaker"
          choice={devices.output}
          options={devices.outputs}
          missing={devices.outputMissing}
          defaultLabel={devices.defaultOutputLabel}
          onChoose={(choice) => devices.setOutput(choice)}
        />
        {systemVoice && (
          <p className="max-w-80 px-2 pt-1 pb-1.5 text-xs text-foreground-muted">
            Replies in the Windows voice always play on the Windows default speaker.
          </p>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});

function DeviceGroup({
  title,
  choice,
  options,
  missing,
  defaultLabel,
  onChoose,
}: {
  title: string;
  choice: AudioDeviceChoice;
  options: readonly AudioDeviceOption[];
  missing: boolean;
  defaultLabel: string;
  onChoose: (choice: AudioDeviceChoice) => void;
}) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label>{title}</DropdownMenu.Label>
      <DropdownMenu.RadioGroup
        value={choice?.id ?? SYSTEM_DEFAULT}
        onValueChange={(value: string) => {
          if (value === SYSTEM_DEFAULT) return onChoose(null);
          const option = options.find((device) => device.id === value);
          if (option) onChoose({ id: option.id, label: option.label });
        }}
      >
        <DropdownMenu.RadioItem value={SYSTEM_DEFAULT}>
          <span className="min-w-0 truncate">
            System default
            {defaultLabel && <span className="text-foreground-passive"> ({defaultLabel})</span>}
          </span>
        </DropdownMenu.RadioItem>
        {options.map((device) => (
          <DropdownMenu.RadioItem key={device.id} value={device.id}>
            <span className="min-w-0 truncate">{device.label}</span>
          </DropdownMenu.RadioItem>
        ))}
        {missing && choice && (
          <DropdownMenu.RadioItem value={choice.id} disabled>
            <span className="min-w-0 truncate">
              {choice.label}
              <span className="text-foreground-passive"> (not connected, using default)</span>
            </span>
          </DropdownMenu.RadioItem>
        )}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
  );
}

function describe(choice: AudioDeviceChoice, missing: boolean, defaultLabel: string): string {
  if (choice && !missing) return choice.label;
  const fallback = defaultLabel ? `System default (${defaultLabel})` : 'System default';
  return choice ? `${fallback}, ${choice.label} not connected` : fallback;
}
