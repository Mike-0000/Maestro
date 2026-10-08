import { remoteDeviceWireContract } from '@emdash/core/services/remote-control/api';
import type { Unsubscribe } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { client, type Connection } from '@emdash/wire/rpc';
import { and, eq, isNull } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';

export type MaestroHostAdoptionDependencies = {
  db: AppDb;
  isMaestroHost(connectionId: string): boolean;
  /** The live Wire connection to a machine, or undefined while it is not connected. */
  connectionFor(connectionId: string): Promise<Connection | undefined>;
  onTaskCreated(handler: (task: { id: string }) => void): Unsubscribe;
  onConversationCreated(handler: (conversation: { id: string }) => void): Unsubscribe;
  logger: Pick<Logger, 'warn'>;
  /** Injected in tests. */
  wait?: (ms: number) => Promise<void>;
};

const ATTEMPTS = 6;
const RETRY_DELAY_MS = 5_000;

/**
 * Task links are local to each Maestro, so a conversation this app starts on another
 * computer's Maestro would have no task there. After creating one, this asks that host to
 * give it a task of its own, which is what makes it appear, already running, in the host's
 * window. Hosts reached over SSH have no window to appear in and are left alone.
 */
export function installMaestroHostAdoption(deps: MaestroHostAdoptionDependencies): Unsubscribe {
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const announced = new Set<string>();

  async function announce(conversationId: string): Promise<void> {
    if (announced.has(conversationId)) return;
    const target = findTarget(deps.db, conversationId);
    if (!target || !deps.isMaestroHost(target.connectionId)) return;
    announced.add(conversationId);

    let lastError = 'the host is not connected';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const connection = await deps.connectionFor(target.connectionId);
        if (connection) {
          const result = await client(
            remoteDeviceWireContract,
            connection
          ).remote.adoptConversation({
            conversationId,
            taskName: target.taskName,
            workspacePath: target.workspacePath,
          });
          if (result.success) return;
          lastError = result.error.message;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < ATTEMPTS) await wait(RETRY_DELAY_MS);
    }
    // A later attempt (the next conversation event for it) may still succeed.
    announced.delete(conversationId);
    deps.logger.warn('The Maestro host did not adopt a conversation started from here', {
      conversationId,
      error: lastError,
    });
  }

  const stopTasks = deps.onTaskCreated((task) => {
    for (const conversationId of conversationIdsOfTask(deps.db, task.id)) {
      void announce(conversationId);
    }
  });
  const stopConversations = deps.onConversationCreated((conversation) => {
    void announce(conversation.id);
  });
  return () => {
    stopTasks();
    stopConversations();
  };
}

function conversationIdsOfTask(db: AppDb, taskId: string): string[] {
  return db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.taskId, taskId), liveConversations()))
    .all()
    .map((row) => row.id);
}

function findTarget(
  db: AppDb,
  conversationId: string
): { connectionId: string; taskName: string; workspacePath: string } | undefined {
  const [row] = db
    .select({
      location: conversations.location,
      connectionId: conversations.sshConnectionId,
      workspacePath: conversations.workspacePath,
      cwd: conversations.cwd,
      taskName: tasks.name,
    })
    .from(conversations)
    .innerJoin(tasks, and(eq(tasks.id, conversations.taskId), isNull(tasks.deletedAt)))
    .where(and(eq(conversations.id, conversationId), liveConversations()))
    .limit(1)
    .all();
  const workspacePath = row?.workspacePath ?? row?.cwd;
  if (!row || row.location !== 'remote' || !row.connectionId || !workspacePath) return undefined;
  return { connectionId: row.connectionId, taskName: row.taskName, workspacePath };
}
