import type { LocalUpdateStatus } from '@core/features/local-updates/api';
import type { LocalUpdatesClient } from '@core/features/local-updates/api/browser/client';

type Candidate = NonNullable<LocalUpdateStatus['candidate']>;

type FlowOptions = {
  confirmPromote(candidate: Candidate): Promise<boolean>;
  confirmSchedule(candidate: Candidate): Promise<boolean>;
  onStage(stage: string): void;
};

/** The one-button path stops at each explicit confirmation; it never pushes to GitHub. */
export async function runLocalUpdateFlow(
  client: LocalUpdatesClient,
  projectId: string,
  options: FlowOptions
): Promise<void> {
  const input = { projectId };
  async function status(): Promise<LocalUpdateStatus> {
    const result = await client.status(input);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  }
  function requireCandidate(current: LocalUpdateStatus, state: string): Candidate {
    const candidate = current.candidate;
    if (candidate?.state === 'blocked' && candidate.error) throw new Error(candidate.error);
    if (!candidate || candidate.state !== state || !candidate.eligible) {
      throw new Error('The update changed while it was running. Refresh and review the candidate.');
    }
    return candidate;
  }

  let current = await status();
  if (!current.enabled) {
    options.onStage('Enabling coordinator…');
    const result = await client.enable(input);
    if (!result.success) throw new Error(result.error.message);
    current = await status();
  }

  let candidate = current.candidate;
  if (
    !candidate ||
    !candidate.eligible ||
    ['installed', 'cancelled', 'rolled-back'].includes(candidate.state) ||
    (candidate.state === 'blocked' && !candidate.error?.startsWith('Integration conflict in '))
  ) {
    options.onStage('Preparing ready snapshot…');
    const result = await client.prepare({ projectId, policy: 'snapshot' }, { timeoutMs: 0 });
    if (!result.success) throw new Error(result.error.message);
    current = await status();
    candidate = requireCandidate(current, 'integrated');
  }
  if (!candidate.eligible)
    throw new Error('Candidate is stale. Refresh before preparing a new one.');
  if (candidate.state === 'integrated') {
    options.onStage('Validating Windows package (this can take several minutes)…');
    // Packaging is a long-running operation, not a 30-second RPC. A disconnect still rejects.
    const result = await client.validate(
      { projectId, candidateId: candidate.id },
      { timeoutMs: 0 }
    );
    if (!result.success) throw new Error(result.error.message);
    current = await status();
    candidate = requireCandidate(current, 'validated');
  }
  if (candidate.state === 'validated') {
    if (!(await options.confirmPromote(candidate))) return;
    options.onStage('Promoting to local chorus/main…');
    const result = await client.promote({ projectId, candidateId: candidate.id });
    if (!result.success) throw new Error(result.error.message);
    current = await status();
    candidate = requireCandidate(current, 'promoted');
  }
  if (candidate.state === 'promoted') {
    if (!(await options.confirmSchedule(candidate))) return;
    options.onStage('Checking idle sessions and scheduling install…');
    const result = await client.schedule(
      { projectId, candidateId: candidate.id, restartPolicy: 'manual' },
      { timeoutMs: 0 }
    );
    if (!result.success) throw new Error(result.error.message);
    return;
  }
  if (candidate.state !== 'applying' && candidate.state !== 'scheduled') {
    throw new Error(`Candidate is ${candidate.state}. Resolve it before continuing.`);
  }
}
