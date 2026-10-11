import { err, ok } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import { createController, type Controller } from '@emdash/wire/rpc';
import { setAttentionJudge } from '@core/primitives/agents/api/attention-judge';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { conductorContract } from '../api/contract';
import { agentRequestEvents, agentRequestHub } from './agent-request-hub';
import { ConductorService } from './conductor-service';
import { checkWorktreeConflicts } from './conflicts';
import {
  InvestigationService,
  type InvestigationPorts,
} from './investigation/investigation-service';
import { readProjectContext } from './project-context';
import { enableGitLongPaths, readSystemChecks } from './system-checks';

export function createConductorWireController(options: {
  host: ChorusHostServices;
  logger: Logger;
  scope: Scope;
  /** What code checks need from other slices; see `InvestigationPorts`. */
  investigator: InvestigationPorts;
}): Controller {
  const service = new ConductorService(options.host, options.logger);
  service.start();
  options.scope.add(() => service.dispose());
  // Agent status asks the conductor's model whether a finished turn needs the developer.
  setAttentionJudge({
    enabled: () => service.attentionEnabled(),
    judge: (input) => service.judgeAttention(input),
  });
  options.scope.add(() => setAttentionJudge(null));
  // The two need each other: checks read settings and usage through the conductor service, and
  // its status reports on checks. Attaching afterwards breaks the circle.
  const investigations = new InvestigationService({
    conductor: service,
    ports: options.investigator,
    dataDir: options.host.dataDir,
    logger: options.logger,
  });
  service.attachInvestigator((settings) => investigations.investigatorStatus(settings));
  options.scope.add(() => investigations.dispose());
  return createController(conductorContract, {
    runTurn: ({ mode, messages }) => service.runTurn(mode, messages),
    decide: ({ state, questions }) => service.decide(state, questions),
    getStatus: () => service.status(),
    updateSettings: (patch) => {
      investigations.settingsChanged(patch);
      return service.updateSettings(patch);
    },
    checkConflicts: async ({ worktrees }) => {
      try {
        return ok(await checkWorktreeConflicts(worktrees));
      } catch (error) {
        return err({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    appendLog: (record) => service.appendLog(record),
    readLog: ({ limit }) => service.readLog(limit),
    appendTrace: (event) => service.appendTrace(event),
    readTrace: (query) => service.readTrace(query),
    deleteDiagnostics: () => service.deleteDiagnostics(),
    getSystemChecks: () => readSystemChecks(),
    projectContext: async ({ path }) => ({
      text: await readProjectContext(path).catch(() => null),
    }),
    enableGitLongPaths: () => enableGitLongPaths(),
    agentRequests: agentRequestEvents,
    acknowledgeAgentRequest: ({ id, ack }) => ({
      delivered: agentRequestHub.acknowledge(id, ack),
    }),
    investigate: {
      run: (input, context) => investigations.run(input, context),
      // Without this, a handler that throws reaches the renderer with no error payload.
      toError: (error) => {
        options.logger.warn('conductor: code check failed', { error });
        return { type: 'failed', message: 'The code check could not be run.' };
      },
    },
    recheckInvestigator: async () => {
      await investigations.recheck();
      return service.status();
    },
  });
}
