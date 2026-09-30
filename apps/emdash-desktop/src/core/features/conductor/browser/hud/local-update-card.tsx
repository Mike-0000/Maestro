import { GitMerge, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { getConductorStore } from '@core/features/conductor/contributions/browser/app-stores';
import type { LocalUpdateStatus } from '@core/features/local-updates/api';
import { getLocalUpdatesClient } from '@core/features/local-updates/api/browser/client';
import {
  asAvailableProject,
  getProjectManagerStore,
  projectData,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { cn } from '@core/primitives/styling/browser/cn';
import { runLocalUpdateFlow } from './local-update-flow';

export const LocalUpdateCard = observer(function LocalUpdateCard({
  onHide,
}: {
  onHide: () => void;
}) {
  const openConfirmation = useOpenModal('confirmActionModal');
  const projects = [...getProjectManagerStore().projects.values()].flatMap((project) => {
    if (!asAvailableProject(project) || projectData(project)?.type !== 'local') return [];
    return [{ id: project.id, name: projectDisplayName(project) ?? 'Maestro project' }];
  });
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [status, setStatus] = useState<LocalUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);

  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) {
      setProjectId(projects[0]?.id ?? null);
      setStatus(null);
    }
  }, [projectId, projects]);

  const refresh = useCallback(
    async (clearError = true) => {
      if (!projectId) return;
      setBusy(true);
      if (clearError) setError(null);
      try {
        const result = await (await getLocalUpdatesClient()).status({ projectId });
        if (!result.success) {
          setError(result.error.message);
          setStatus(null);
        } else {
          setStatus(result.data);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus(null);
      } finally {
        setBusy(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runUpdate() {
    if (!projectId || !status || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runLocalUpdateFlow(await getLocalUpdatesClient(), projectId, {
        onStage: setStage,
        confirmPromote: async (candidate) =>
          (
            await openConfirmation({
              title: 'Promote changes to local chorus/main?',
              description: `Validated candidate ${candidate.id.slice(0, 8)} includes ${candidate.included.map((task) => task.taskName).join(', ')}. This fast-forwards local chorus/main, keeping unrelated local edits in its checkout.`,
              confirmLabel: 'Promote locally',
            })
          ).success,
        confirmSchedule: async (candidate) =>
          (
            await openConfirmation({
              title: 'Schedule the local Maestro install?',
              description: `Candidate ${candidate.id.slice(0, 8)} is promoted. No agents, terminals, or remote sessions can be active. Maestro stays open until you quit normally; the installer then replaces the app and checks that it starts. New agent work is paused while the installer waits.`,
              confirmLabel: 'Schedule install',
            })
          ).success,
      });
      await getConductorStore().plans.refreshDeliveryReadiness();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStage(null);
      await refresh(false);
      setBusy(false);
    }
  }

  async function run(
    operation: 'resume' | 'push-backup' | 'cancel-install' | 'cancel-candidate' | 'rollback',
    selectedCandidateId = status?.candidate?.id
  ) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (['push-backup', 'rollback'].includes(operation) && selectedCandidateId) {
        const confirmation = await openConfirmation({
          title:
            operation === 'push-backup'
              ? 'Push this candidate to GitHub origin/main?'
              : 'Restore the retained Maestro build and its profile?',
          description:
            operation === 'push-backup'
              ? 'This pushes the exact promoted commit to origin/main without force. A rejected push leaves the GitHub backup pending.'
              : 'The installer restores the exact retained pre-update Maestro build and its matched pre-update profile. The current profile is preserved in local recovery storage. Stop every agent, terminal, and remote session; Maestro stays open until you quit normally, then the rollback starts and verifies startup.',
          confirmLabel: operation === 'push-backup' ? 'Push backup' : 'Restore previous build',
        });
        if (!confirmation.success) return;
      }
      const client = await getLocalUpdatesClient();
      const result =
        operation === 'resume' && selectedCandidateId
          ? await client.resume({ projectId, candidateId: selectedCandidateId })
          : operation === 'push-backup' && selectedCandidateId
            ? await client.pushBackup({ projectId, candidateId: selectedCandidateId })
            : (operation === 'cancel-install' || operation === 'cancel-candidate') &&
                selectedCandidateId
              ? await client.cancel({ projectId, candidateId: selectedCandidateId })
              : operation === 'rollback' && selectedCandidateId
                ? await client.rollback({
                    projectId,
                    candidateId: selectedCandidateId,
                    restoreProfile: true,
                  })
                : null;
      if (!result) return;
      if (!result.success) setError(result.error.message);
      await refresh(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (projects.length === 0) return null;
  const candidate = status?.candidate;
  const activeTasks = status?.tasks.filter((task) => task.state !== 'withdrawn') ?? [];
  const withdrawnCount = (status?.tasks.length ?? 0) - activeTasks.length;
  return (
    <section
      aria-label="Local Maestro update"
      className="pointer-events-auto w-full max-w-[560px] rounded-2xl border border-border bg-background/95 p-3 text-foreground shadow-xl backdrop-blur"
    >
      <header className="flex items-center gap-2">
        <GitMerge className="size-4 shrink-0 text-foreground-muted" />
        <h2 className="flex-1 text-xs font-semibold">Local Maestro update</h2>
        {projects.length > 1 && (
          <select
            aria-label="Delivery project"
            className="max-w-48 rounded border border-border bg-background px-2 py-1 text-xs"
            value={projectId ?? ''}
            disabled={busy}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-label="Refresh local update status"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded p-1 text-foreground-muted hover:bg-background-secondary disabled:opacity-50"
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          aria-label="Hide local Maestro update"
          title="Hide local Maestro update"
          disabled={busy}
          onClick={onHide}
          className="rounded p-1 text-foreground-muted hover:bg-background-secondary disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </header>

      {stage && <p className="mt-2 text-xs text-foreground-muted">{stage}</p>}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>}
      {!status && !error && (
        <p className="mt-2 text-xs text-foreground-muted">Loading delivery status…</p>
      )}
      {status && (
        <>
          <p className="mt-2 text-xs text-foreground-muted">
            {status.enabled
              ? `Generation ${status.generation} · ${activeTasks.length} enrolled tasks${
                  withdrawnCount > 0 ? ` · ${withdrawnCount} withdrawn` : ''
                }`
              : 'The durable project coordinator is not enabled.'}
          </p>
          {status.targetInstallGate && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Candidate {status.targetInstallGate.candidateId.slice(0, 8)} owns the local install
              target. New Maestro sessions are paused until it completes.
            </p>
          )}
          {activeTasks.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {activeTasks.map((task) => (
                <li
                  key={task.taskId}
                  className="rounded-full bg-background-secondary px-2 py-0.5 text-[11px]"
                >
                  {task.taskName}: {task.state}
                </li>
              ))}
            </ul>
          )}
          {candidate && (
            <div className="mt-2 rounded-lg border border-border bg-background-secondary/50 px-2.5 py-2 text-xs">
              <p className="font-medium">
                Candidate {candidate.id.slice(0, 8)} · {candidate.state}
              </p>
              <p className="mt-1 text-foreground-muted">
                {candidate.included.map((task) => task.taskName).join(', ') ||
                  'No included changes'}
              </p>
              {!candidate.eligible && (
                <p className="mt-1 text-amber-700 dark:text-amber-300">
                  New project work made this candidate stale.
                </p>
              )}
              {(candidate.error ||
                candidate.validation?.error ||
                (candidate.state === 'blocked' && status.lastError)) && (
                <p className="mt-1 text-red-600 dark:text-red-300">
                  {candidate.error ?? candidate.validation?.error ?? status.lastError}
                </p>
              )}
              {candidate.error?.startsWith('Integration conflict in ') && (
                <p className="mt-1 text-foreground-muted">
                  Resolve and commit in <code className="break-all">{candidate.worktreePath}</code>,
                  then resume integration.
                </p>
              )}
              {['rolling-back', 'recovery-required'].includes(candidate.state) &&
                candidate.error && (
                  <p className="mt-1 text-amber-700 dark:text-amber-300">
                    The update worker stopped before recovery was verified. New sessions remain
                    paused; do not start agents. Close Maestro normally if it is still open, and
                    keep the install journal and recovery folders intact while resolving the
                    displayed error.
                  </p>
                )}
              {candidate.state === 'validated' && (
                <p className="mt-1 flex items-center gap-1 text-green-700 dark:text-green-300">
                  <ShieldCheck className="size-3.5" /> Windows package hashes recorded
                </p>
              )}
              {candidate.githubBackup && (
                <p className="mt-1 text-foreground-muted">
                  GitHub backup: {candidate.githubBackup.state}
                  {candidate.githubBackup.error ? ` · ${candidate.githubBackup.error}` : ''}
                </p>
              )}
              {candidate.state === 'applying' && (
                <div className="mt-1 flex items-center gap-2 text-amber-700 dark:text-amber-300">
                  <p className="flex-1">
                    Install worker is waiting. Quit Maestro normally when you are ready to apply it.
                  </p>
                  <ActionButton
                    disabled={busy}
                    onClick={() => void run('cancel-install', candidate.id)}
                  >
                    Cancel install
                  </ActionButton>
                </div>
              )}
            </div>
          )}
          {status.githubBackups.length > 0 && (
            <ul className="mt-2 space-y-1 rounded-lg border border-border bg-background-secondary/50 px-2.5 py-2 text-xs">
              {status.githubBackups.map((backup) => (
                <li key={backup.candidateId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    GitHub backup pending Â· {backup.candidateId.slice(0, 8)}
                    {backup.error ? ` Â· ${backup.error}` : ''}
                  </span>
                  <ActionButton
                    disabled={busy}
                    onClick={() => void run('push-backup', backup.candidateId)}
                  >
                    Push
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(!candidate ||
              !candidate.eligible ||
              [
                'installed',
                'cancelled',
                'rolled-back',
                'integrated',
                'validated',
                'promoted',
              ].includes(candidate.state) ||
              (candidate.state === 'blocked' &&
                !candidate.error?.startsWith('Integration conflict in '))) && (
              <ActionButton disabled={busy} onClick={() => void runUpdate()}>
                {busy ? (stage ?? 'Updating…') : 'Update Maestro'}
              </ActionButton>
            )}
            {candidate?.state === 'blocked' &&
              candidate.error?.startsWith('Integration conflict in ') && (
                <ActionButton disabled={busy} onClick={() => void run('resume')}>
                  Resume resolved integration
                </ActionButton>
              )}
            {candidate?.state === 'promoted' && (
              <ActionButton
                disabled={busy}
                onClick={() => void run('cancel-candidate', candidate.id)}
              >
                Cancel install candidate
              </ActionButton>
            )}
            {candidate?.state === 'installed' &&
              candidate.health?.previousBuild?.deliveryProtocol === 1 && (
                <ActionButton disabled={busy} onClick={() => void run('rollback')}>
                  Roll back local install
                </ActionButton>
              )}
          </div>
        </>
      )}
    </section>
  );
});

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-background-secondary disabled:cursor-not-allowed disabled:opacity-50'
      )}
    >
      {children}
    </button>
  );
}
