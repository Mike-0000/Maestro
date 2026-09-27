export function launchInstallWorker(input: {
  stateRoot: string;
  workerPath: string | null;
  job: Record<string, unknown> & { candidateId: string; jobId?: string };
}): Promise<{ jobPath: string }>;

export function requestInstallWorkerCancel(input: {
  stateRoot: string;
  candidateId: string;
}): Promise<{ cancelled: true; alreadyCancelled: boolean } | { cancelled: false; applying: true }>;
