import type { Logger } from '@emdash/shared/logger';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import type { VoiceSettings } from '../api/contract';
import {
  acceleratorFromStored,
  HOLD_KEY_OFF,
  HoldComboTracker,
  holdComboKeycodes,
} from '../api/global-keys';
import { HoldToTalkMachine, type HoldOutput } from '../api/hold-to-talk';

export type GlobalVoiceKeyPorts = Pick<ChorusHostServices, 'globalShortcuts' | 'keyboardHook'>;

export type GlobalVoiceKeySettings = Pick<VoiceSettings, 'globalShortcut' | 'globalHoldKey'>;

/**
 * The system-wide talk keys of one computer: the toggle-to-talk shortcut (Electron
 * `globalShortcut`) and hold-to-talk (the system key hook). The local app runs them in its main
 * process; a client-mode window runs its own, since the keyboard is on the client computer and
 * not on the host that stores the settings.
 */
export class GlobalVoiceKeys {
  private registeredShortcut: string | null = null;
  private holdActive = false;
  private readonly hold: HoldToTalkMachine;
  /** The stored settings; null until the first `apply`. */
  private desired: GlobalVoiceKeySettings | null = null;
  /** Whether this process may use the keys now (see `voice-focus.ts`). */
  private active = true;
  /** What the OS mechanisms were last set to; only a mechanism whose value changed is touched. */
  private applied: GlobalVoiceKeySettings | null = null;

  constructor(
    private readonly ports: GlobalVoiceKeyPorts,
    private readonly onToggle: () => void,
    onHold: (output: HoldOutput) => void,
    private readonly logger: Pick<Logger, 'warn'>
  ) {
    this.hold = new HoldToTalkMachine(onHold);
  }

  /**
   * The toggle shortcut works in this process. While another Maestro window holds the keys this
   * reports whether one is set, since it is registered again as soon as this window is focused.
   */
  get shortcutRegistered(): boolean {
    if (!this.active) return acceleratorFromStored(this.desired?.globalShortcut ?? '') !== '';
    return this.registeredShortcut !== null;
  }

  /** Hold-to-talk works in this process (or is set and waits for this window's focus). */
  get holdKeyActive(): boolean {
    if (!this.active) {
      const key = this.desired?.globalHoldKey.trim() ?? HOLD_KEY_OFF;
      return key !== HOLD_KEY_OFF && key !== '' && holdComboKeycodes(key) !== null;
    }
    return this.holdActive;
  }

  apply(settings: GlobalVoiceKeySettings): void {
    this.desired = {
      globalShortcut: settings.globalShortcut,
      globalHoldKey: settings.globalHoldKey,
    };
    this.sync();
  }

  /** Turns the keys on in the focused Maestro window and off in every other one. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.sync();
  }

  dispose(): void {
    this.applyHold(HOLD_KEY_OFF);
    if (this.registeredShortcut) this.ports.globalShortcuts.unregister(this.registeredShortcut);
    this.registeredShortcut = null;
    this.applied = null;
    this.desired = null;
  }

  private sync(): void {
    if (!this.desired) return;
    const next: GlobalVoiceKeySettings = this.active
      ? this.desired
      : { globalShortcut: '', globalHoldKey: HOLD_KEY_OFF };
    const previous = this.applied;
    this.applied = next;
    if (!previous || previous.globalShortcut !== next.globalShortcut) {
      this.applyShortcut(next.globalShortcut);
    }
    if (!previous || previous.globalHoldKey !== next.globalHoldKey) {
      this.applyHold(next.globalHoldKey);
    }
  }

  /** Starts or stops the system-wide key hook for global hold-to-talk. */
  private applyHold(key: string): void {
    if (this.holdActive) {
      this.ports.keyboardHook.stop();
      this.hold.reset();
      this.holdActive = false;
    }
    if (key.trim() === HOLD_KEY_OFF || !key.trim()) return;
    const keycodes = holdComboKeycodes(key);
    if (!keycodes) {
      this.logger.warn('voice: unsupported global hold-to-talk key', { key });
      return;
    }
    const tracker = new HoldComboTracker(keycodes, this.hold);
    const started = this.ports.keyboardHook.start((event) => tracker.onKey(event));
    if (started) this.holdActive = true;
    else this.logger.warn('voice: global hold-to-talk could not start');
  }

  private applyShortcut(accelerator: string): void {
    if (this.registeredShortcut) this.ports.globalShortcuts.unregister(this.registeredShortcut);
    this.registeredShortcut = null;
    const trimmed = acceleratorFromStored(accelerator);
    if (!trimmed) return;
    try {
      if (this.ports.globalShortcuts.register(trimmed, this.onToggle)) {
        this.registeredShortcut = trimmed;
      } else {
        this.logger.warn('voice: global shortcut is taken by another app', {
          accelerator: trimmed,
        });
      }
    } catch (error) {
      this.logger.warn('voice: invalid global shortcut', { accelerator: trimmed, error });
    }
  }
}
