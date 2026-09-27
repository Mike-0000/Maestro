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

export const LocalUpdateCard = observer(function LocalUpdateCard({
  onHide,
}: {
  onHide: () => void;
}) {
  const openConfirmation = useOpenModal('confirmActionModal');
  const projects = [...getProjectManagerStore().projects.values()].flatMap((project) => {
    if (!asAvailableProject(project) || projectData(project)?.type !== 'local') return [];
    return [{ id: project.id, name: projectDisplayName(project) ?? 'Chorus project' }];
  });
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [status, setStatus] = useState<LocalUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) {
      setProjectId(projects[0]?.id ?? null);
      setStatus(null);
    }
  }, [projectId, projects]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
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
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(
    operation:
      | 'enable'
      | 'snapshot'
      | 'follow'
      | 'resume'
      | 'validate'
      | 'promote'
      | 'push-backup'
      | 'schedule'
      | 'cancel-install'
      | 'cancel-candidate'
      | 'rollback',
    selectedCandidateId = status?.candidate?.id
  ) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (
        ['promote', 'push-backup', 'schedule', 'rollback'].includes(operation) &&
        selectedCandidateId
      ) {
        const confirmation = await openConfirmation({
          title:
            operation === 'promote'
              ? 'Promote changes to local chorus/main?'
              : operation === 'push-backup'
                ? 'Push this candidate to GitHub origin/main?'
                : operation === 'rollback'
                  ? 'Restore the retained Chorus build and its profile?'
                  : 'Schedule the local Chorus install?',
          description:
            operation === 'promote'
              ? 'This fast-forwards the local chorus/main branch if its checkout is clean and unchanged.'
              : operation === 'push-backup'
                ? 'This pushes the exact promoted commit to origin/main without force. A rejected push leaves the GitHub backup pending.'
                : operation === 'rollback'
                  ? 'The installer restores the exact retained pre-update Chorus build and its matched pre-update profile. The current profile is preserved in local recovery storage. Stop every agent, terminal, and remote session; Chorus stays open until you quit normally, then the rollback starts and verifies startup.'
                  : 'No agents, terminals, or remote sessions can be active. Chorus stays open until you quit normally; the installer then replaces the app and checks that it starts. New agent work is paused while the installer waits.',
          confirmLabel:
            operation === 'promote'
              ? 'Promote locally'
              : operation === 'push-backup'
                ? 'Push backup'
                : operation === 'rollback'
                  ? 'Restore previous build'
                  : 'Schedule install',
        });
        if (!confirmation.success) return;
      }
      const client = await getLocalUpdatesClient();
      const result =
        operation === 'enable'
          ? await client.enable({ projectId })
          : operation === 'snapshot'
            ? await client.prepare({ projectId, policy: 'snapshot' })
            : operation === 'follow'
              ? await client.prepare({ projectId, policy: 'follow-project' })
              : operation === 'resume' && status?.candidate
                ? await client.resume({ projectId, candidateId: status.candidate.id })
                : operation === 'validate' && selectedCandidateId
                  ? await client.validate({ projectId, candidateId: selectedCandidateId })
                  : operation === 'promote' && selectedCandidateId
                    ? await client.promote({ projectId, candidateId: selectedCandidateId })
                    : operation === 'push-backup' && selectedCandidateId
                      ? await client.pushBackup({ projectId, candidateId: selectedCandidateId })
                      : operation === 'schedule' && selectedCandidateId
                        ? await client.schedule({
                            projectId,
                            candidateId: selectedCandidateId,
                            restartPolicy: 'manual',
                          })
                        : operation === 'cancel-install' && selectedCandidateId
                          ? await client.cancel({ projectId, candidateId: selectedCandidateId })
                          : operation === 'cancel-candidate' && selectedCandidateId
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
      else if (operation === 'promote') {
        await getConductorStore().plans.refreshDeliveryReadiness();
      }
      await refresh();
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
      aria-label="Local Chorus update"
      className="pointer-events-auto w-full max-w-[560px] rounded-2xl border border-border bg-background/95 p-3 text-foreground shadow-xl backdrop-blur"
    >
      <header className="flex items-center gap-2">
        <GitMerge className="size-4 shrink-0 text-foreground-muted" />
        <h2 className="flex-1 text-xs font-semibold">Local Chorus update</h2>
        {projects.length > 1 && (
          <select
            aria-label="Delivery project"
            className="max-w-48 rounded border border-border bg-background px-2 py-1 text-xs"
            value={projectId ?? ''}
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
          aria-label="Hide local Chorus update"
          title="Hide local Chorus update"
          onClick={onHide}
          className="rounded p-1 text-foreground-muted hover:bg-background-secondary"
        >
          <X className="size-3.5" />
        </button>
      </header>

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
              target. New Chorus sessions are paused until it completes.
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
              {candidate.error && (
                <p className="mt-1 text-red-600 dark:text-red-300">{candidate.error}</p>
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
                    paused; do not start agents. Close Chorus normally if it is still open, and keep
                    the install journal and recovery folders intact while resolving the displayed
                    error.
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
                    Install worker is waiting. Quit Chorus normally when you are ready to apply it.
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
            {!status.enabled ? (
              <ActionButton disabled={busy} onClick={() => void run('enable')}>
                Enable coordinator
              </ActionButton>
            ) : (
              <>
                <ActionButton disabled={busy} onClick={() => void run('snapshot')}>
                  Prepare ready snapshot
                </ActionButton>
                <ActionButton disabled={busy} onClick={() => void run('follow')}>
                  Wait for all active work
                </ActionButton>
                {candidate?.state === 'integrated' && (
                  <ActionButton
                    disabled={busy || !candidate.eligible}
                    onClick={() => void run('validate')}
                  >
                    Validate package
                  </ActionButton>
                )}
                {candidate?.state === 'blocked' &&
                  candidate.error?.startsWith('Integration conflict in ') && (
                    <ActionButton disabled={busy} onClick={() => void run('resume')}>
                      Resume resolved integration
                    </ActionButton>
                  )}
                {candidate?.state === 'validated' && candidate.eligible && (
                  <ActionButton disabled={busy} onClick={() => void run('promote')}>
                    Promote to chorus/main
                  </ActionButton>
                )}
                {candidate?.state === 'promoted' && candidate.eligible && (
                  <>
                    <ActionButton disabled={busy} onClick={() => void run('schedule')}>
                      Schedule local install
                    </ActionButton>
                    <ActionButton
                      disabled={busy}
                      onClick={() => void run('cancel-candidate', candidate.id)}
                    >
                      Cancel install candidate
                    </ActionButton>
                  </>
                )}
                {candidate?.state === 'installed' &&
                  candidate.health?.previousBuild?.deliveryProtocol === 1 && (
                    <ActionButton disabled={busy} onClick={() => void run('rollback')}>
                      Roll back local install
                    </ActionButton>
                  )}
              </>
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
