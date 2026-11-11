import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Select, Spinner } from '@emdash/ui/react/primitives';
import { GitMerge, RefreshCw, ShieldCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
import { HudCard, HudCardHeader } from './hud-card';
import { runLocalUpdateFlow } from './local-update-flow';

/**
 * The local Maestro update ("ship"): the delivery state of the project's enrolled tasks, the
 * current candidate, and the one move it allows. It is a tool for working on Maestro itself, so
 * it keeps to the bar's right end, narrow, instead of the middle of the content.
 */
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
  const projectName = projects.find((project) => project.id === projectId)?.name ?? '';
  return (
    // The wrapper spans the bar's width so the card can sit at its right end.
    <div className="pointer-events-none flex w-full max-w-220 justify-end">
      <HudCard label="Local Maestro update" className="max-w-md">
        <HudCardHeader
          glyph={<GitMerge aria-hidden className="size-3.5 text-foreground-muted" />}
          title="Local Maestro update"
          actions={
            <>
              {projects.length > 1 && (
                <Select.Root
                  value={projectId ?? ''}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (typeof value === 'string' && value) setProjectId(value);
                  }}
                >
                  <Select.Trigger aria-label="Delivery project" className="h-7 w-36 text-xs">
                    <Select.Value>{projectName}</Select.Value>
                  </Select.Trigger>
                  <Select.Content align="end">
                    {projects.map((project) => (
                      <Select.Item key={project.id} value={project.id}>
                        {project.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                aria-label="Refresh local update status"
                title="Refresh local update status"
                disabled={busy}
                onClick={() => void refresh()}
                className="-mr-3"
              >
                {busy ? <Spinner size="sm" /> : <RefreshCw aria-hidden />}
              </Button>
            </>
          }
          onClose={onHide}
          closeLabel="Hide local Maestro update"
          closeDisabled={busy}
        />

        <div className="mt-1 space-y-2 pl-6 text-xs">
          {stage && <p className="text-foreground-muted">{stage}</p>}
          {error && (
            <p className="flex gap-1.5 text-foreground">
              <span className="flex h-4.5 shrink-0 items-center">
                <StateGlyph state="error" size="sm" />
              </span>
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
          {!status && !error && <p className="text-foreground-muted">Loading delivery status…</p>}
          {status && (
            <>
              <p className="text-tiny text-foreground-passive tabular-nums">
                {status.enabled
                  ? `Generation ${status.generation} · ${activeTasks.length} enrolled tasks${
                      withdrawnCount > 0 ? ` · ${withdrawnCount} withdrawn` : ''
                    }`
                  : 'The durable project coordinator is not enabled.'}
              </p>
              {status.targetInstallGate && (
                <p className="text-foreground-warning">
                  Candidate {status.targetInstallGate.candidateId.slice(0, 8)} owns the local
                  install target. New Maestro sessions are paused until it completes.
                </p>
              )}
              {activeTasks.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {activeTasks.map((task) => (
                    <li
                      key={task.taskId}
                      className="rounded-full bg-surface-emphasis px-2 py-0.5 text-tiny text-foreground-muted"
                    >
                      <span className="text-foreground">{task.taskName}</span>: {task.state}
                    </li>
                  ))}
                </ul>
              )}
              {candidate && (
                <div className="space-y-1 rounded-lg bg-surface-emphasis px-3 py-2.5">
                  <p className="font-medium text-foreground">
                    Candidate {candidate.id.slice(0, 8)} · {candidate.state}
                  </p>
                  <p className="text-foreground-muted">
                    {candidate.included.map((task) => task.taskName).join(', ') ||
                      'No included changes'}
                  </p>
                  {!candidate.eligible && (
                    <p className="text-foreground-warning">
                      New project work made this candidate stale.
                    </p>
                  )}
                  {(candidate.error ||
                    candidate.validation?.error ||
                    (candidate.state === 'blocked' && status.lastError)) && (
                    <p className="text-foreground-error">
                      {candidate.error ?? candidate.validation?.error ?? status.lastError}
                    </p>
                  )}
                  {candidate.error?.startsWith('Integration conflict in ') && (
                    <p className="text-foreground-muted">
                      Resolve and commit in{' '}
                      <code className="rounded-xs bg-surface-hover px-1 font-mono break-all">
                        {candidate.worktreePath}
                      </code>
                      , then resume integration.
                    </p>
                  )}
                  {['rolling-back', 'recovery-required'].includes(candidate.state) &&
                    candidate.error && (
                      <p className="text-foreground-warning">
                        The update worker stopped before recovery was verified. New sessions remain
                        paused; do not start agents. Close Maestro normally if it is still open, and
                        keep the install journal and recovery folders intact while resolving the
                        displayed error.
                      </p>
                    )}
                  {candidate.state === 'validated' && (
                    <p className="flex items-center gap-1.5 text-foreground-muted">
                      <ShieldCheck aria-hidden className="size-3.5 text-foreground-passive" />
                      Windows package hashes recorded
                    </p>
                  )}
                  {candidate.githubBackup && (
                    <p className="text-foreground-muted">
                      GitHub backup: {candidate.githubBackup.state}
                      {candidate.githubBackup.error ? ` · ${candidate.githubBackup.error}` : ''}
                    </p>
                  )}
                  {candidate.state === 'applying' && (
                    <div className="flex items-center gap-3 pt-0.5">
                      <p className="flex-1 text-foreground-warning">
                        Install worker is waiting. Quit Maestro normally when you are ready to apply
                        it.
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
                <ul className="space-y-1 rounded-lg bg-surface-emphasis px-3 py-2.5">
                  {status.githubBackups.map((backup) => (
                    <li key={backup.candidateId} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 text-foreground-muted">
                        GitHub backup pending · {backup.candidateId.slice(0, 8)}
                        {backup.error ? ` · ${backup.error}` : ''}
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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
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
                  <ActionButton primary disabled={busy} onClick={() => void runUpdate()}>
                    {busy ? (stage ?? 'Updating…') : 'Update Maestro'}
                  </ActionButton>
                )}
                {candidate?.state === 'blocked' &&
                  candidate.error?.startsWith('Integration conflict in ') && (
                    <ActionButton primary disabled={busy} onClick={() => void run('resume')}>
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
        </div>
      </HudCard>
    </div>
  );
});

/** The card's move is a primary button; everything else a quiet text action. */
function ActionButton({
  children,
  disabled,
  primary = false,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  primary?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      type="button"
      variant={primary ? 'primary' : 'text'}
      size={primary ? 'sm' : 'xs'}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0"
    >
      {children}
    </Button>
  );
}
