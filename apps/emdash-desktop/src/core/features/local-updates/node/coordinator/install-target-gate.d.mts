export type InstallTargetGate = {
  version: 1;
  ownerId: string;
  repositoryPath: string;
  projectId: string;
  candidateId: string;
  commit: string;
  phase: string;
  createdAt: string;
};

export function readInstallTargetGate(stateRoot: string): Promise<InstallTargetGate | null>;
export function reserveInstallTargetGate(input: {
  stateRoot: string;
  ownerId: string;
  repositoryPath: string;
  projectId: string;
  candidateId: string;
  commit: string;
}): Promise<{ owned: boolean; gate: InstallTargetGate }>;
export function releaseInstallTargetGate(input: {
  stateRoot: string;
  ownerId: string;
  repositoryPath: string;
  candidateId: string;
}): Promise<boolean>;
export function acquireDispatchLease(input: {
  stateRoot: string;
  ownerId: string;
}): Promise<() => void>;
export function waitForDispatchLeases(
  stateRoot: string,
  options?: { pollIntervalMs?: number }
): Promise<void>;
