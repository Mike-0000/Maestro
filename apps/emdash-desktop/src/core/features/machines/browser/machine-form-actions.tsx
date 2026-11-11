import { Button, Spinner } from '@emdash/ui/react/primitives';
import { CheckIcon, ChevronDown, ChevronUp, TriangleAlert, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ConnectionTestResult } from '@core/primitives/ssh/api';
import { cn } from '@core/primitives/styling/browser/cn';
import type { MachineFormController, MachineTestState } from './use-machine-form';
import type { SshConfigResolution } from './use-ssh-config-hosts';

/**
 * The dialog footer: "Test connection" as a quiet text action on the left, Cancel (ghost) and the
 * one primary action on the right.
 */
export function MachineFormActions({
  actions,
  resolution,
  isEditing,
  formId,
  cancelAction,
}: {
  actions: MachineFormController['actions'];
  resolution: SshConfigResolution;
  isEditing: boolean;
  formId: string;
  cancelAction?: ReactNode;
}) {
  const resolving = !actions.ready && resolution.status === 'resolving';
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {actions.ready && (
          <Button
            type="button"
            variant="text"
            onClick={actions.test}
            disabled={actions.isTesting || actions.isSaving}
          >
            {actions.isTesting ? (
              <>
                <Spinner size="sm" />
                Testing…
              </>
            ) : (
              'Test connection'
            )}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {cancelAction}
        <Button
          type="submit"
          variant="primary"
          form={formId}
          disabled={actions.disabled || resolving}
        >
          {actions.isSaving ? (
            <>
              <Spinner size="sm" />
              Saving…
            </>
          ) : !actions.ready ? (
            resolving ? (
              'Resolving…'
            ) : resolution.status === 'failed' ? (
              'Retry'
            ) : (
              'Resolve'
            )
          ) : isEditing ? (
            'Save'
          ) : (
            'Add host'
          )}
        </Button>
      </div>
    </div>
  );
}

export function MachineFormFeedback({ test, saveError }: MachineFormController['feedback']) {
  return (
    <>
      {test.status !== 'idle' && <TestFeedback key={test.status} test={test} />}
      {saveError && (
        <p role="alert" className="text-xs text-foreground-error">
          Could not save connection: {saveError}
        </p>
      )}
    </>
  );
}

/**
 * The connection test's answer in one quiet well: a passive check when it worked, the error mark
 * when it did not (the only colour), and the platform findings under it.
 */
function TestFeedback({ test }: { test: Exclude<MachineTestState, { status: 'idle' }> }) {
  const [showDebugLogs, setShowDebugLogs] = useState(false);
  const result = test.status === 'finished' ? test.result : undefined;
  const failed = result && !result.success;
  return (
    <div className="rounded-lg bg-surface-emphasis px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        {test.status === 'testing' ? (
          <Spinner size="sm" className="text-foreground-passive" />
        ) : failed ? (
          <XCircle aria-hidden className="size-4 shrink-0 text-foreground-error" />
        ) : (
          <CheckIcon aria-hidden className="size-4 shrink-0 text-foreground-muted" />
        )}
        <span className="min-w-0 flex-1 font-medium break-words text-foreground">
          {test.status === 'testing'
            ? 'Testing connection…'
            : failed
              ? (result.error ?? 'Connection failed')
              : `Connected${result?.latency ? ` (${result.latency}ms)` : ''}`}
        </span>
        {failed && result.debugLogs?.length ? (
          <Button
            type="button"
            variant="text"
            aria-expanded={showDebugLogs}
            onClick={() => setShowDebugLogs((value) => !value)}
          >
            {showDebugLogs ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            Logs
          </Button>
        ) : null}
      </div>
      {result?.success && <PlatformFeedback result={result} />}
      {showDebugLogs && result?.debugLogs && (
        <pre className="mt-2 max-h-32 overflow-y-auto rounded-md bg-surface px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-foreground-muted">
          {result.debugLogs.join('\n')}
        </pre>
      )}
    </div>
  );
}

/** What the post-connect platform check found; blocking issues stop Maestro from using the host. */
function PlatformFeedback({ result }: { result: ConnectionTestResult }) {
  const { platform, platformError } = result;
  if (platformError) {
    return (
      <p className="mt-1 pl-6 text-xs text-foreground-warning">
        Could not check the remote platform: {platformError}
      </p>
    );
  }
  if (!platform) return null;
  const blocked = platform.issues.some((issue) => issue.severity === 'error');
  return (
    <div className="mt-1 grid gap-1 pl-6 text-xs">
      <p className="text-foreground-muted">
        {platform.description}
        {blocked ? ' · Maestro cannot use this machine yet' : ''}
      </p>
      {platform.issues.length > 0 && (
        <ul className="grid gap-1 pl-0">
          {platform.issues.map((issue) => (
            <li
              key={issue.code}
              className={cn(
                'flex list-none items-start gap-1.5',
                issue.severity === 'error' ? 'text-foreground-error' : 'text-foreground-warning'
              )}
            >
              {issue.severity === 'error' ? (
                <XCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
