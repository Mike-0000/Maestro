import type { Result } from '@emdash/shared';
import type { AutomationRun, AutomationRunRequest } from '../../api';

export type TriggerDaemonError = { type: string; message: string };

/**
 * What the trigger HTTP surface needs from an automations runtime. Narrow so the HTTP layer
 * tests against a fake, and so the same routes serve a daemon and a desktop app.
 */
export interface TriggerDaemon {
  healthy(): Promise<boolean>;
  startRun(
    automationId: string,
    request: AutomationRunRequest
  ): Promise<Result<AutomationRun, TriggerDaemonError>>;
  getRun(
    automationId: string,
    runId: string
  ): Promise<Result<AutomationRun | null, TriggerDaemonError>>;
  cancelRun(automationId: string, runId: string): Promise<Result<void, TriggerDaemonError>>;
  queuedCount(automationId: string): Promise<Result<number, TriggerDaemonError>>;
}
