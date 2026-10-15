import type { Logger } from '@emdash/shared/logger';
import { createController, type Controller } from '@emdash/wire/rpc';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { talkContract } from '../api/contract';
import { TalkService } from './talk-service';

export function createTalkWireController(options: {
  host: ChorusHostServices;
  logger: Logger;
}): Controller {
  const service = new TalkService(options.host, options.logger);
  return createController(talkContract, {
    getStatus: () => service.status(),
    updateSettings: (patch) => service.updateSettings(patch),
    openSession: (input) => service.openSession(input),
    recordUsage: ({ model, tokens, seconds, textInputs }) =>
      service.recordUsage(model, tokens, { seconds, textInputs }),
  });
}
