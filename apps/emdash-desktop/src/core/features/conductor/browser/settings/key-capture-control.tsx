import { Button } from '@emdash/ui/react/primitives';
import { useEffect, useRef, useState } from 'react';
import { KeyCaptureSession, type KeyComboResult } from '@core/features/voice/api/global-keys';

/**
 * A key-listen control: click it, then press a key or hold several keys together and release.
 * `resolve` turns the held `KeyboardEvent.code` values into the stored value, or explains why
 * that combination cannot be used. Esc or clicking again cancels.
 */
export function KeyCaptureControl({
  label,
  ariaLabel,
  disabled = false,
  resolve,
  onCommit,
  onClear,
}: {
  /** The current binding as shown to the user; null when nothing is set. */
  label: string | null;
  ariaLabel: string;
  disabled?: boolean;
  resolve: (codes: readonly string[]) => KeyComboResult;
  onCommit: (value: string) => void;
  /** When given, shows a button that turns the binding off. */
  onClear?: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef(resolve);
  const onCommitRef = useRef(onCommit);
  resolveRef.current = resolve;
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (!recording) return;
    const session = new KeyCaptureSession();
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      swallow(event);
      if (event.repeat) return;
      if (session.keyDown(event.code) === 'cancel') setRecording(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      swallow(event);
      const codes = session.keyUp();
      if (!codes) return;
      setRecording(false);
      const result = resolveRef.current(codes);
      if (result.ok) onCommitRef.current(result.value);
      else setError(result.reason);
    };
    const onBlur = () => setRecording(false);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, [recording]);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          aria-label={ariaLabel}
          className={recording ? 'min-w-[120px] animate-pulse' : 'min-w-[120px]'}
          disabled={disabled}
          onClick={() => {
            setError(null);
            setRecording((current) => !current);
          }}
        >
          {recording ? 'Press keys…' : (label ?? 'Click to set')}
        </Button>
        {onClear && label !== null && !recording && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => {
              setError(null);
              onClear();
            }}
          >
            Turn off
          </Button>
        )}
      </div>
      {error && (
        <span role="alert" className="max-w-64 text-right text-xs text-foreground-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
