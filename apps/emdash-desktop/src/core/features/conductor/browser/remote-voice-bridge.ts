import { comparer, reaction } from 'mobx';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type {
  RemoteConductorCommand,
  RemoteConductorSnapshot,
} from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import { log } from '@core/primitives/logging/browser/logger';
import type { ConductorStore } from './conductor-store';
import { buildRoster } from './roster';

const PUBLISH_DELAY_MS = 80;
const SUBTASK_DETAIL_CHARS = 200;
const VOCABULARY_LIMIT = 200;

/** The conductor's heads-up display, in the shape paired devices mirror. */
export function conductorSnapshot(
  conductor: ConductorStore,
  canvas: CanvasStore
): RemoteConductorSnapshot {
  const plan = conductor.plans.plan;
  return {
    phase: conductor.phase,
    activity: conductor.activity,
    lastUtterance: conductor.lastUtterance,
    reply: conductor.reply,
    replyAt: conductor.replyAt,
    error: conductor.error?.message ?? null,
    pending: conductor.pending
      ? {
          id: conductor.pending.id,
          label: conductor.pending.label,
          kind: conductor.pending.kind,
          startedAt: conductor.pending.startedAt,
          durationMs: conductor.pending.durationMs,
        }
      : null,
    plan: plan
      ? {
          goal: plan.goal,
          status: plan.status,
          subtasks: plan.subtasks.map((subtask) => ({
            name: subtask.title,
            detail: subtask.prompt.slice(0, SUBTASK_DETAIL_CHARS),
          })),
        }
      : null,
    agentNames: buildRoster(canvas)
      .filter((agent) => !agent.hidden)
      .map((agent) => agent.name),
    vocabulary: conductor.vocabulary().slice(0, VOCABULARY_LIMIT),
  };
}

/**
 * Carries out what a paired device asked for. Device input arrives as typed text: the
 * conductor then shows its reply without speaking it on this computer, and the device voices
 * it instead. "yes" and "no" go through the same grammar a spoken answer does, so
 * confirmations and plan approval behave exactly as they do here.
 */
export function runRemoteConductorCommand(
  conductor: Pick<ConductorStore, 'handleUtterance'>,
  command: RemoteConductorCommand
): Promise<void> {
  return conductor.handleUtterance(
    command.type === 'utterance' ? command.text : command.decision,
    'typed'
  );
}

/**
 * Makes this window's conductor reachable from paired devices: its display is published as it
 * changes, and commands from devices are run here, where the canvas and the agents are.
 */
export function startRemoteVoiceBridge(conductor: ConductorStore, canvas: CanvasStore): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const stopPublishing = reaction(
    () => conductorSnapshot(conductor, canvas),
    (snapshot) => {
      void getRemoteAccessClient()
        .then((client) => client.publishConductorState(snapshot))
        .catch((error: unknown) => log.warn('remote voice: publishing state failed', { error }));
    },
    { fireImmediately: true, delay: PUBLISH_DELAY_MS, equals: comparer.structural }
  );

  void getRemoteAccessClient()
    .then(async (client) => {
      const next = await client.conductorCommands.subscribe(undefined, {
        onEvent: (command) => {
          void runRemoteConductorCommand(conductor, command).catch((error: unknown) =>
            log.warn('remote voice: command failed', { error })
          );
        },
      });
      if (disposed) next();
      else unsubscribe = next;
    })
    .catch((error: unknown) => log.warn('remote voice: subscribing failed', { error }));

  return () => {
    disposed = true;
    stopPublishing();
    unsubscribe?.();
  };
}
