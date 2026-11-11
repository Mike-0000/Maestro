import { Button, Input, Spinner, toast } from '@emdash/ui/react/primitives';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { HostDependencyInstallation } from '@core/features/agents/api/browser/use-agent-installation-statuses';

export type InstallationOverrideCardProps = {
  vm: HostDependencyInstallation;
  kind: 'path' | 'cli';
  /** Initial value from persisted selection, if any. */
  initialValue?: string;
  /** Called when checking state changes (for parent to derive 'checking' state). */
  onChecking: (isChecking: boolean) => void;
  onSaved: () => void;
};

export function InstallationOverrideCard({
  vm,
  kind,
  initialValue = '',
  onChecking,
  onSaved,
}: InstallationOverrideCardProps) {
  const [value, setValue] = useState(initialValue);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleValidate = async () => {
    setIsChecking(true);
    setError(null);
    onChecking(true);
    try {
      const selection = kind === 'path' ? { kind, path: value } : { kind, command: value };
      await vm.resolve(selection);
      await vm.setUsed(selection);
      toast('Executable override saved');
      onSaved();
    } catch (error) {
      setError(
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : 'Could not validate or save this executable.'
      );
    } finally {
      setIsChecking(false);
      onChecking(false);
    }
  };

  const hasValue = value.trim().length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label={kind === 'path' ? 'Executable path' : 'Command name'}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder={
            kind === 'path' ? '/usr/local/bin/claude' : kind === 'cli' ? 'claude' : undefined
          }
          className="min-w-0 flex-1 font-mono text-xs"
          disabled={isChecking}
        />
        {hasValue && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={isChecking}
            onClick={() => void handleValidate()}
          >
            {isChecking && <Spinner size="sm" />}
            Validate
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-foreground-error">
          {error}
        </p>
      )}
      <p className="flex items-start gap-1.5 text-xs text-foreground-muted">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" aria-hidden />
        <span>
          {kind === 'path'
            ? "Using an absolute path to the agent binary overrides auto-resolution and disables Maestro's ability to update the agent."
            : "Enter the command name or binary resolved on PATH. This overrides auto-resolution and disables Maestro's ability to update the agent."}
        </span>
      </p>
    </div>
  );
}
