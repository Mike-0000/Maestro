import { MonitorSmartphone } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useId, useRef, useState, type FormEvent } from 'react';
import { guessDeviceName } from '../lib/device-name';
import {
  isCompletePairingCode,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
} from '../lib/pairing-code';
import type { PairFailure } from '../lib/session-api';
import { useApp } from './app-context';
import { BrandMark } from './BrandMark';
import { Button } from './controls';
import { cx } from './hooks';

const FAILURE_TEXT: Record<PairFailure, string> = {
  'invalid-code':
    'That code didn’t work. Codes are single-use and expire after a few minutes — get a fresh one and try again.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try a new code.',
  unreachable: 'Couldn’t reach your computer. Check that Maestro is running and try again.',
};

const DEVICE_NAME_MAX = 60;

export const PairingScreen = observer(function PairingScreen() {
  const app = useApp();
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(() =>
    guessDeviceName(navigator.userAgent, navigator.maxTouchPoints)
  );
  const [failure, setFailure] = useState<PairFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const errorId = useId();
  const nameId = useId();

  const complete = isCompletePairingCode(code);
  const name = deviceName.trim();

  const submit = async (candidate: string): Promise<void> => {
    if (busy || !isCompletePairingCode(candidate) || !name) return;
    setBusy(true);
    setFailure(null);
    const reason = await app.pair(normalizePairingCode(candidate), name);
    setBusy(false);
    if (!reason) return;
    setFailure(reason);
    setAttempt((count) => count + 1);
    if (reason === 'invalid-code') setCode('');
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void submit(code);
  };

  return (
    <main className="scroll-area pt-safe pb-safe flex h-full w-full flex-col items-center px-6">
      <form
        onSubmit={onSubmit}
        className="animate-fade-in my-auto flex w-full max-w-sm flex-col items-center py-10"
        noValidate
      >
        <BrandMark size={48} />
        <h1 className="text-hero mt-6 text-center text-balance text-foreground">
          Connect to {app.session?.hostName ?? 'your computer'}
        </h1>
        <p className="text-body mt-3 text-center text-balance text-foreground-muted">
          Enter the pairing code shown in Maestro on your computer.
        </p>

        <CodeField
          key={attempt}
          value={code}
          disabled={busy}
          invalid={failure === 'invalid-code'}
          describedBy={failure ? errorId : undefined}
          shake={attempt > 0 && failure === 'invalid-code'}
          onChange={(next) => {
            setCode(next);
            if (failure) setFailure(null);
          }}
        />

        <div
          id={errorId}
          role="alert"
          className={cx(
            'mt-3 min-h-9 text-center text-detail text-balance',
            failure ? 'text-foreground-error' : 'text-foreground-passive'
          )}
        >
          {failure ? FAILURE_TEXT[failure] : null}
        </div>

        <label htmlFor={nameId} className="text-body mt-4 w-full text-foreground">
          Name this device
        </label>
        <div className="field mt-1.5 flex h-12 w-full items-center gap-2.5 rounded-md px-3.5">
          <MonitorSmartphone
            className="size-4 shrink-0 text-foreground-passive"
            aria-hidden="true"
          />
          <input
            id={nameId}
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value.slice(0, DEVICE_NAME_MAX))}
            maxLength={DEVICE_NAME_MAX}
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="go"
            required
            className="text-reading h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-foreground-passive"
            placeholder="My phone"
          />
        </div>

        <Button
          type="submit"
          variant="primary"
          block
          busy={busy}
          disabled={!complete || !name}
          className="mt-6 h-12"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>

        <p className="text-detail mt-6 text-center text-balance text-foreground-muted">
          On your computer, open Maestro and go to{' '}
          <span className="text-foreground">Settings → Remote access → Pair a device</span>.
        </p>
      </form>
    </main>
  );
});

type CodeFieldProps = {
  value: string;
  disabled: boolean;
  invalid: boolean;
  shake: boolean;
  describedBy: string | undefined;
  onChange(value: string): void;
};

/**
 * Eight cells drawn over one real text field. A single input is what makes paste, autofill,
 * the phone's own cursor handling and auto-advance work without any of the focus juggling
 * that per-character inputs need.
 */
function CodeField({ value, disabled, invalid, shake, describedBy, onChange }: CodeFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, PAIRING_CODE_LENGTH - 1);

  return (
    <div className={cx('relative mt-7 w-full', shake && 'animate-shake')}>
      <div aria-hidden="true" className="flex items-center justify-center gap-1.5">
        {Array.from({ length: PAIRING_CODE_LENGTH }, (_, index) => (
          <span key={index} className="contents">
            {index === PAIRING_CODE_LENGTH / 2 ? (
              <span className="mx-0.5 h-0.5 w-2.5 shrink-0 rounded-full bg-border" />
            ) : null}
            <span
              data-invalid={invalid || undefined}
              data-focused={(!invalid && focused && index === active) || undefined}
              className={cx(
                'field flex aspect-[5/7] min-w-0 flex-1 items-center justify-center rounded-md font-mono text-title',
                disabled && 'opacity-60'
              )}
            >
              {value[index] ?? ''}
            </span>
          </span>
        ))}
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(normalizePairingCode(event.target.value))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        autoFocus
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="one-time-code"
        spellCheck={false}
        enterKeyHint="go"
        aria-label="Pairing code, 8 characters"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        // Wider than the code so a paste like "ABCD-EFGH " is not cut off before normalising.
        maxLength={PAIRING_CODE_LENGTH + 8}
        className="absolute inset-0 h-full w-full cursor-text rounded-md bg-transparent text-transparent caret-transparent opacity-0 outline-none"
      />
    </div>
  );
}
