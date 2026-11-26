import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '@core/services/app-db/node/db';
import { automationRuns } from '@core/services/app-db/node/schema';
import { countInFlightAutomationRuns } from './host-activity';

const NOW = 10 * 60 * 60 * 1000;
const MINUTE = 60_000;

describe('in-flight automation runs', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
  });

  afterEach(() => {
    fixture.close();
  });

  it('counts recent runs between queueing and their session starting', async () => {
    const row = (
      id: string,
      status: string,
      startedAt: number | null,
      scheduledAt: number | null
    ) => ({
      id,
      automationId: 'automation-1',
      automationName: 'Nightly',
      status: status as never,
      scheduledAt,
      startedAt,
      finishedAt: null,
      seq: 1,
    });
    await fixture.db.insert(automationRuns).values([
      row('queued', 'queued', null, NOW - MINUTE),
      row('provisioning', 'provisioning_workspace', NOW - 2 * MINUTE, NOW - 3 * MINUTE),
      row('starting', 'starting_session', NOW - MINUTE, null),
      row('done', 'done', NOW - MINUTE, NOW - MINUTE),
      row('scheduled', 'scheduled', null, NOW + MINUTE),
      // Left behind by a crash hours ago: not a reason to hold an update forever.
      row('stale', 'queued', null, NOW - 3 * 60 * MINUTE),
    ]);
    expect(await countInFlightAutomationRuns(fixture.db as unknown as AppDb, NOW)).toBe(3);
  });

  it('is zero on an empty database', async () => {
    expect(await countInFlightAutomationRuns(fixture.db as unknown as AppDb, NOW)).toBe(0);
  });
});
