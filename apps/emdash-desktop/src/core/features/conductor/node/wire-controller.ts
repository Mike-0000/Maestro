import { err, ok } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { createController, type Controller } from '@emdash/wire/rpc';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { conductorContract } from '../api/contract';
import { ConductorService } from './conductor-service';
import { checkWorktreeConflicts } from './conflicts';
import { readProjectContext } from './project-context';
import { enableGitLongPaths, readSystemChecks } from './system-checks';

export function createConductorWireController(options: {
  host: ChorusHostServices;
  logger: Logger;
}): Controller {
  const service = new ConductorService(options.host, options.logger);
  return createController(conductorContract, {
    runTurn: ({ mode, messages }) => service.runTurn(mode, messages),
    decide: ({ state, questions }) => service.decide(state, questions),
    getStatus: () => service.status(),
    updateSettings: (patch) => service.updateSettings(patch),
    checkConflicts: async ({ worktrees }) => {
      try {
        return ok(await checkWorktreeConflicts(worktrees));
      } catch (error) {
        return err({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    appendLog: (record) => service.appendLog(record),
    readLog: ({ limit }) => service.readLog(limit),
    getSystemChecks: () => readSystemChecks(),
    projectContext: async ({ path }) => ({
      text: await readProjectContext(path).catch(() => null),
    }),
    enableGitLongPaths: () => enableGitLongPaths(),
  });
}
