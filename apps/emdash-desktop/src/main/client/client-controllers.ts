import type { Logger } from '@emdash/shared/logger';
import {
  createController,
  forwardContractImpl,
  forwardController,
  queuedClient,
  type Contract,
  type ContractClient,
  type ContractDefinitions,
  type Controller,
} from '@emdash/wire/rpc';
import { ownerHostWireContract } from '@core/features/client-mode/api/owner-contract';
import { conversationsContract } from '@core/features/conversations/api';
import { terminalsContract } from '@core/features/terminals/api';
import { voiceContract } from '@core/features/voice/api';
import {
  clientModeDomains,
  clientModeRouting,
  type DesktopDomain,
} from '@core/manifests/shared/client-mode-routing';
import { desktopDomainContracts } from '@core/manifests/shared/domain-contracts';
import type { TerminalFileSources } from '@core/services/attachments/node/prepare-terminal-files';
import { prepareMixedLocalFiles } from './adapters/attachments';
import type { OwnerHostClient } from './host-link';

// The client's desktop Wire bundle, built from the routing table: a `forward` domain is a
// forwarder to the host, every other domain needs a controller of the client's own. The renderer
// is served by this bundle exactly as the local app's renderer is served by its own.

type Routing = typeof clientModeRouting;

/** The desktop domains the client answers itself, in whole (`local`) or in part (`custom`). */
export type ClientHandledDomain = {
  [Domain in DesktopDomain]: Routing[Domain]['client'] extends 'forward' ? never : Domain;
}[DesktopDomain];

/**
 * A view of the host's owner contract whose calls wait for the first attach (`ready` never
 * rejects) and, after that, ride the link's one Wire connection, which holds them across drops.
 */
export function queuedOwnerClient(ready: () => Promise<OwnerHostClient>): OwnerHostClient {
  return queuedClient(ownerHostWireContract, ready);
}

export function buildClientControllers(options: {
  host: OwnerHostClient;
  handled: Record<ClientHandledDomain, Controller>;
  /** Client-only domains outside the desktop contract (`clientSession`). */
  extra?: Record<string, Controller>;
}): Record<string, Controller> {
  const controllers: Record<string, Controller> = {};
  for (const domain of clientModeDomains('forward')) {
    controllers[domain] = forwardDomain(domain, options.host);
  }
  for (const domain of Object.keys(clientModeRouting) as DesktopDomain[]) {
    if (controllers[domain]) continue;
    const controller = (options.handled as Partial<Record<DesktopDomain, Controller>>)[domain];
    if (!controller) throw new Error(`Client mode has no controller for the '${domain}' domain`);
    controllers[domain] = controller;
  }
  for (const [domain, controller] of Object.entries(options.extra ?? {})) {
    if (controllers[domain]) throw new Error(`Client domain '${domain}' is already registered`);
    controllers[domain] = controller;
  }
  return controllers;
}

function forwardDomain(domain: DesktopDomain, host: OwnerHostClient): Controller {
  // Per-domain generics cannot be expressed in a loop over the table; each pair is the same
  // domain's contract and client, so the widening is sound.
  return forwardController(
    desktopDomainContracts[domain] as Contract<ContractDefinitions>,
    host.desktop[domain] as ContractClient<ContractDefinitions>
  );
}

/** `terminals`: forwarded, except rule P for `attachments.prepareLocalFiles`. */
export function createClientTerminalsController(
  host: OwnerHostClient,
  deps: { localFiles: TerminalFileSources; logger: Logger }
): Controller {
  const remote = host.desktop.terminals;
  const impl = forwardContractImpl(terminalsContract, remote);
  return createController(terminalsContract, {
    ...impl,
    attachments: {
      ...impl.attachments,
      prepareLocalFiles: ({ workspaceId, sources }, meta) =>
        prepareMixedLocalFiles({
          sources,
          localFiles: deps.localFiles,
          logger: deps.logger,
          signal: meta.signal,
          forward: (subset) =>
            remote.attachments.prepareLocalFiles(
              { workspaceId, sources: subset },
              { signal: meta.signal }
            ),
          upload: (file) =>
            remote.attachments.upload({ workspaceId }, file, { signal: meta.signal }),
          remove: (attachmentId) => remote.attachments.delete({ workspaceId, attachmentId }),
        }),
    },
  });
}

/** `conversations`: forwarded, except rule P for `attachments.prepareLocalFiles`. */
export function createClientConversationsController(
  host: OwnerHostClient,
  deps: { localFiles: TerminalFileSources; logger: Logger }
): Controller {
  const remote = host.desktop.conversations;
  const impl = forwardContractImpl(conversationsContract, remote);
  return createController(conversationsContract, {
    ...impl,
    attachments: {
      ...impl.attachments,
      prepareLocalFiles: ({ conversationId, sources }, meta) =>
        prepareMixedLocalFiles({
          sources,
          localFiles: deps.localFiles,
          logger: deps.logger,
          signal: meta.signal,
          forward: (subset) =>
            remote.attachments.prepareLocalFiles(
              { conversationId, sources: subset },
              { signal: meta.signal }
            ),
          upload: (file) =>
            remote.attachments.upload({ conversationId }, file, { signal: meta.signal }),
          remove: (attachmentId) => remote.attachments.delete({ conversationId, attachmentId }),
        }),
    },
  });
}

/** `voice`: forwarded, except `openMicrophoneSettings`, which opens this computer's settings. */
export function createClientVoiceController(
  host: OwnerHostClient,
  openMicrophoneSettings: () => Promise<void>
): Controller {
  const impl = forwardContractImpl(voiceContract, host.desktop.voice);
  return createController(voiceContract, {
    ...impl,
    openMicrophoneSettings: () => openMicrophoneSettings(),
  });
}
