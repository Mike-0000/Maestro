import type { DeliveryCandidate, DeliveryValidation } from './coordinator.mjs';

export const VALIDATION_COMMANDS: readonly (readonly [name: string, command: string])[];
export const REQUIRED_BUILD_CHECKS: readonly string[];
export function deliveryBootstrapCommands(
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform
): readonly (readonly [name: string, command: string])[] | null;

export function validateIntegratedCandidate(input: {
  repositoryPath: string;
  candidate: DeliveryCandidate;
  stateRoot: string;
  git: (cwd: string, args: string[]) => Promise<string>;
}): Promise<DeliveryValidation>;

export function assertSqliteBinding(moduleRoot: string): Promise<void>;
export function hashTree(root: string): Promise<{ path: string; sha256: string }[]>;
