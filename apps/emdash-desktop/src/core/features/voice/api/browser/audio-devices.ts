import { makeAutoObservable, runInAction } from 'mobx';

/** A device the developer picked; null follows the Windows default. */
export type AudioDeviceChoice = { readonly id: string; readonly label: string } | null;

export type AudioDeviceOption = { readonly id: string; readonly label: string };

/** The part of `navigator.mediaDevices` the store uses. */
export type MediaDevicesLike = {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  addEventListener(type: 'devicechange', listener: () => void): void;
  removeEventListener(type: 'devicechange', listener: () => void): void;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const INPUT_KEY = 'chorus:audio-input-device';
const OUTPUT_KEY = 'chorus:audio-output-device';
/** Chromium's stand-ins for whatever Windows has as its default and communications device. */
const PSEUDO_IDS = new Set(['default', 'communications']);

type Listener = () => void;

/**
 * The microphones and speakers this computer has, which of them the voice uses, and when that
 * changes. A capture stream in Chromium stays on the physical device it was opened on, even when
 * the Windows default moves to another one; the open microphones listen to `onInputChange` and
 * move to the device it names, so a new default is heard without restarting the app.
 */
export class AudioDevicesStore {
  inputs: AudioDeviceOption[] = [];
  outputs: AudioDeviceOption[] = [];
  /** The Windows default's own name, '' when it is not known. */
  defaultInputLabel = '';
  defaultOutputLabel = '';
  input: AudioDeviceChoice;
  output: AudioDeviceChoice;

  /** What the Windows default microphone is now: its group and name. */
  private defaultInput = '';
  private inputKey = '';
  private outputKey = '';
  private readonly inputListeners = new Set<Listener>();
  private readonly outputListeners = new Set<Listener>();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private active = false;
  private readonly onDeviceChange = () => void this.refresh();

  constructor(
    private readonly media: MediaDevicesLike | null,
    private readonly storage: StorageLike | null
  ) {
    this.input = readChoice(storage, INPUT_KEY);
    this.output = readChoice(storage, OUTPUT_KEY);
    makeAutoObservable<
      AudioDevicesStore,
      | 'media'
      | 'storage'
      | 'defaultInput'
      | 'inputKey'
      | 'outputKey'
      | 'inputListeners'
      | 'outputListeners'
      | 'refreshing'
      | 'refreshAgain'
      | 'active'
      | 'onDeviceChange'
    >(this, {
      media: false,
      storage: false,
      defaultInput: false,
      inputKey: false,
      outputKey: false,
      inputListeners: false,
      outputListeners: false,
      refreshing: false,
      refreshAgain: false,
      active: false,
      onDeviceChange: false,
    });
  }

  /** Starts following the device list. Safe to call more than once. */
  activate(): void {
    if (this.active || !this.media) return;
    this.active = true;
    this.media.addEventListener('devicechange', this.onDeviceChange);
    void this.refresh();
  }

  dispose(): void {
    if (!this.active || !this.media) return;
    this.active = false;
    this.media.removeEventListener('devicechange', this.onDeviceChange);
  }

  /** The microphone a new stream should open, or null for the Windows default. */
  get inputDeviceId(): string | null {
    const choice = this.input;
    return choice && this.inputs.some((device) => device.id === choice.id) ? choice.id : null;
  }

  /** The speaker for `setSinkId`: '' plays through the Windows default. */
  get outputSinkId(): string {
    const choice = this.output;
    return choice && this.outputs.some((device) => device.id === choice.id) ? choice.id : '';
  }

  /** The picked microphone is not plugged in, so the default is used meanwhile. */
  get inputMissing(): boolean {
    return this.input !== null && this.inputs.length > 0 && this.inputDeviceId === null;
  }

  get outputMissing(): boolean {
    return this.output !== null && this.outputs.length > 0 && this.outputSinkId === '';
  }

  /** `base` with the picked microphone, for `getUserMedia`. */
  audioConstraints(base: MediaTrackConstraints): MediaTrackConstraints {
    const id = this.inputDeviceId;
    return id ? { ...base, deviceId: { exact: id } } : base;
  }

  setInput(choice: AudioDeviceChoice): void {
    this.input = choice;
    writeChoice(this.storage, INPUT_KEY, choice);
    this.settle();
  }

  setOutput(choice: AudioDeviceChoice): void {
    this.output = choice;
    writeChoice(this.storage, OUTPUT_KEY, choice);
    this.settle();
  }

  /** Called when the microphone a new stream would open is another one than before. */
  onInputChange(listener: Listener): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /** Called when `outputSinkId` changes. */
  onOutputChange(listener: Listener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** Reads the device list again; overlapping calls are folded into one more read. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = async (): Promise<void> => {
      do {
        this.refreshAgain = false;
        await this.read();
      } while (this.refreshAgain);
    };
    const refreshing = run().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = refreshing;
    return refreshing;
  }

  private async read(): Promise<void> {
    if (!this.media) return;
    let devices: MediaDeviceInfo[];
    try {
      devices = await this.media.enumerateDevices();
    } catch {
      return;
    }
    const inputs = listOf(devices, 'audioinput', 'Microphone');
    const outputs = listOf(devices, 'audiooutput', 'Speaker');
    const defaultInput = devices.find((d) => d.kind === 'audioinput' && d.deviceId === 'default');
    const defaultOutput = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
    runInAction(() => {
      this.inputs = inputs;
      this.outputs = outputs;
      this.defaultInputLabel = defaultName(defaultInput);
      this.defaultOutputLabel = defaultName(defaultOutput);
      // A device id can change (cleared site data); the same name is the same device.
      this.input = rematch(this.input, inputs);
      this.output = rematch(this.output, outputs);
      this.defaultInput = identity(defaultInput);
    });
    this.settle();
  }

  /** Tells the listeners when the device in use is another one than before. */
  private settle(): void {
    const inputId = this.inputDeviceId;
    const inputKey = inputId ? `device:${inputId}` : `default:${this.defaultInput}`;
    const outputKey = this.outputSinkId;
    // Until the default has a name (before the microphone is first allowed) it is not known, so
    // learning it is not a change.
    const known = this.inputKey !== '' && this.inputKey !== 'default:';
    const inputChanged = known && inputKey !== this.inputKey;
    const outputChanged = outputKey !== this.outputKey;
    this.inputKey = inputKey;
    this.outputKey = outputKey;
    if (inputChanged) for (const listener of [...this.inputListeners]) listener();
    if (outputChanged) for (const listener of [...this.outputListeners]) listener();
  }
}

function listOf(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallback: string
): AudioDeviceOption[] {
  const list = devices.filter((d) => d.kind === kind && d.deviceId && !PSEUDO_IDS.has(d.deviceId));
  return list.map((device, index) => ({
    id: device.deviceId,
    label: device.label || `${fallback} ${index + 1}`,
  }));
}

/** "Default - Headset (Jabra)" is shown as "Headset (Jabra)". */
function defaultName(device: MediaDeviceInfo | undefined): string {
  return device?.label.replace(/^Default\s*-\s*/u, '') ?? '';
}

/** Which device the default is, '' while Chromium gives no name for it. */
function identity(device: MediaDeviceInfo | undefined): string {
  return device?.label ? `${device.groupId}|${device.label}` : '';
}

function rematch(choice: AudioDeviceChoice, list: readonly AudioDeviceOption[]): AudioDeviceChoice {
  if (!choice || list.some((device) => device.id === choice.id)) return choice;
  const same = list.find((device) => device.label === choice.label);
  return same ? { id: same.id, label: same.label } : choice;
}

function readChoice(storage: StorageLike | null, key: string): AudioDeviceChoice {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'id' in parsed &&
      'label' in parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.label === 'string' &&
      parsed.id
    ) {
      return { id: parsed.id, label: parsed.label };
    }
  } catch {
    // Unreadable: the default is used.
  }
  return null;
}

function writeChoice(storage: StorageLike | null, key: string, choice: AudioDeviceChoice): void {
  try {
    if (choice) storage?.setItem(key, JSON.stringify(choice));
    else storage?.removeItem(key);
  } catch {
    // Storage full or blocked: the choice lasts until the app closes.
  }
}

let shared: AudioDevicesStore | null = null;

/** The app's one device store, following the device list from its first use. */
export function getAudioDevices(): AudioDevicesStore {
  if (!shared) {
    const media =
      typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : null;
    let storage: StorageLike | null = null;
    try {
      storage = typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      storage = null;
    }
    shared = new AudioDevicesStore(media, storage);
    shared.activate();
  }
  return shared;
}

/** Opens the picked microphone, or the default when the picked one cannot be opened. */
export async function openMicrophoneStream(
  base: MediaTrackConstraints,
  devices: AudioDevicesStore = getAudioDevices()
): Promise<MediaStream> {
  const constraints = devices.audioConstraints(base);
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    const missing = name === 'NotFoundError' || name === 'OverconstrainedError';
    if (constraints === base || !missing) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }
}
