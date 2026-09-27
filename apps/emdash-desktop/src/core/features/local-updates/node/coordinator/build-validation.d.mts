import type { DeliveryCandidate, DeliveryValidation } from './coordinator.mjs';

export const REQUIRED_BUILD_CHECKS: readonly string[];

export function validateIntegratedCandidate(input: {
  repositoryPath: string;
  candidate: DeliveryCandidate;
  stateRoot: string;
  git: (cwd: string, args: string[]) => Promise<string>;
}): Promise<DeliveryValidation>;

export function assertSqliteBinding(moduleRoot: string): Promise<void>;
