import type { HostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { and, inArray, sql } from 'drizzle-orm';
import type { AppDb } from '@core/services/app-db/node/db';
import { automationRuns } from '@core/services/app-db/node/schema';

// Whether this host is doing work an unattended restart would cut short. Read only by the
// unattended update policy, which runs only when `hostUpdates.mode` is `when-idle` or an owner
// client asks for a host update; the ordinary app never calls it.
//
// Busy means: a chat (ACP) session is working or generating, a terminal agent reports `working`
// (its own turn or background work it is waiting on), or an automation run is between queueing
// and its agent session starting. Open shells and agents that wait for a person do not count:
// on a host nobody sits at they could wait forever. A read that fails or times out counts as busy.

const READ_DEADLINE_MS = 2_000;
/** Runs stuck in a start state for longer than this are treated as leftovers of a crash. */
const IN_FLIGHT_RUN_MAX_AGE_MS = 60 * 60 * 1000;
const IN_FLIGHT_RUN_STATUSES = ['queued', 'provisioning_workspace', 'starting_session'] as const;

export type HostActivity = {
  busy: boolean;
  /** A short description for the log, such as `2 working agents`. */
  detail: string;
};

export type HostActivitySources = {
  runtimes: Pick<RuntimeBroker, 'client'>;
  attachedHosts(): readonly HostRef[];
  inFlightAutomationRuns(): Promise<number>;
};

export async function readHostActivity(sources: HostActivitySources): Promise<HostActivity> {
  const hosts = sources.attachedHosts();
  const [perHost, runs] = await Promise.all([
    Promise.all(hosts.map((host) => readHostWork(sources.runtimes, host))),
    withDeadline(() => sources.inFlightAutomationRuns()),
  ]);
  let chats = 0;
  let agents = 0;
  let unknown = runs === null;
  for (const work of perHost) {
    if (work.chats === null || work.agents === null) unknown = true;
    chats += work.chats ?? 0;
    agents += work.agents ?? 0;
  }
  const parts: string[] = [];
  if (chats > 0) parts.push(`${chats} working chat${chats === 1 ? '' : 's'}`);
  if (agents > 0) parts.push(`${agents} working agent${agents === 1 ? '' : 's'}`);
  if (runs) parts.push(`${runs} starting automation run${runs === 1 ? '' : 's'}`);
  if (unknown) parts.push('activity could not be read');
  return { busy: parts.length > 0, detail: parts.length > 0 ? parts.join(', ') : 'idle' };
}

/** Automation runs between queueing and their agent session starting, recent ones only. */
export async function countInFlightAutomationRuns(db: AppDb, now = Date.now()): Promise<number> {
  const since = now - IN_FLIGHT_RUN_MAX_AGE_MS;
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuns)
    .where(
      and(
        inArray(automationRuns.status, [...IN_FLIGHT_RUN_STATUSES]),
        sql`coalesce(${automationRuns.startedAt}, ${automationRuns.scheduledAt}, 0) >= ${since}`
      )
    );
  return Number(rows[0]?.count ?? 0);
}

async function readHostWork(
  runtimes: Pick<RuntimeBroker, 'client'>,
  host: HostRef
): Promise<{ chats: number | null; agents: number | null }> {
  const client = runtimes.client(host).then((result) => {
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  });
  void client.catch(() => undefined);
  const [chats, agents] = await Promise.all([
    withDeadline(async () => {
      const snapshot = await (await client).acp.sessions.state(undefined, 'list').snapshot();
      return Object.values(snapshot.data).filter(
        (session) => session.lifecycle === 'working' || session.isGenerating
      ).length;
    }),
    withDeadline(async () => {
      const snapshot = await (
        await client
      ).tuiAgents.agentStates
        .state(undefined, 'list')
        .snapshot();
      return Object.values(snapshot.data).filter((agent) => agent.status === 'working').length;
    }),
  ]);
  return { chats, agents };
}

/** The value, or null when the read failed or took longer than the deadline. */
async function withDeadline<T>(read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = read();
    void pending.catch(() => undefined);
    return await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_DEADLINE_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
