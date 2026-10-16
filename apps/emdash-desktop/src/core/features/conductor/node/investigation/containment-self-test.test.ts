import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runContainmentSelfTest,
  SCOUT_PROFILE,
  SelfTestRecord,
  type SelfTestScout,
} from './containment-self-test';
import type { ScoutRun } from './scout-runner';

const VERSION = '2.1.296';

type Ask = Parameters<SelfTestScout>[0];
type Kind = 'plain' | 'outside' | 'secret' | 'extra';

function kindOf(ask: Ask): Kind {
  if (ask.question.includes('outside.txt')) return 'outside';
  const [extra] = ask.extraFolders;
  if (extra && ask.question.includes(extra)) return 'extra';
  return ask.question.includes('.env') ? 'secret' : 'plain';
}

function answered(denied: string[] = [], costUsd = 0.001): ScoutRun {
  return {
    status: 'answered',
    answer: { answer: 'Done.', found: 'no', evidence: [] },
    denials: denied.map((file) => ({ tool: 'Read', path: file })),
    costUsd,
    version: VERSION,
    durationMs: 10,
  };
}

function failed(
  reason: Extract<ScoutRun, { status: 'failed' }>['reason'],
  message: string
): ScoutRun {
  return { status: 'failed', reason, message, costUsd: 0, version: VERSION, durationMs: 10 };
}

/** A CLI that behaves: it refuses both reads and reports them. */
function contained(ask: Ask): ScoutRun {
  const kind = kindOf(ask);
  if (kind === 'outside') return answered([path.join(path.dirname(ask.cwd), 'outside.txt')]);
  if (kind === 'extra') return answered([path.join(ask.extraFolders[0] ?? '', '.env')]);
  // The CLI reports the path it was asked for, which may be relative.
  return kind === 'secret' ? answered(['.env']) : answered();
}

/** Runs the self-test with a scripted scout and records what it was asked. */
async function selfTest(
  script: (ask: Ask, kind: Kind, attempt: number) => ScoutRun | Promise<ScoutRun>
) {
  const asked: Kind[] = [];
  const folders = new Set<string>();
  const outcome = await runContainmentSelfTest(async (ask) => {
    const kind = kindOf(ask);
    asked.push(kind);
    folders.add(ask.cwd);
    return script(ask, kind, asked.filter((other) => other === kind).length);
  });
  return { outcome, asked, folders: [...folders] };
}

describe('runContainmentSelfTest', () => {
  it('passes when both reads are refused and no hook ran, then removes its fixture', async () => {
    const { outcome, asked, folders } = await selfTest((ask) => contained(ask));
    expect(outcome.status).toBe('passed');
    expect(outcome).toMatchObject({ version: VERSION });
    expect(outcome.costUsd).toBeCloseTo(0.004);
    expect([...asked].sort()).toEqual(['extra', 'outside', 'plain', 'secret']);
    expect(folders).toHaveLength(1);
    expect(existsSync(folders[0] ?? '')).toBe(false);
  });

  it('builds a project with a hook, a denied file, and a canary outside it', async () => {
    let seen: { hook: string; secret: string; outside: string } | null = null;
    await selfTest(async (ask) => {
      seen ??= {
        hook: await readFile(path.join(ask.cwd, '.claude', 'settings.json'), 'utf8'),
        secret: await readFile(path.join(ask.cwd, '.env'), 'utf8'),
        outside: await readFile(path.join(path.dirname(ask.cwd), 'outside.txt'), 'utf8'),
      };
      return contained(ask);
    });
    const fixture = seen as { hook: string; secret: string; outside: string } | null;
    expect(JSON.parse(fixture?.hook ?? '{}')).toMatchObject({
      hooks: { SessionStart: [{ hooks: [{ type: 'command' }, { type: 'command' }] }] },
    });
    expect(fixture?.secret).toMatch(/^SCOUT_CANARY=scout-secret-[0-9a-f]{16}\n$/);
    expect(fixture?.outside).toMatch(/^scout-outside-[0-9a-f]{16}\n$/);
  });

  it("fails when a hook from the project's settings ran", async () => {
    for (const marker of [
      (ask: Ask) => path.join(path.dirname(ask.cwd), 'scout-hook-ran.txt'),
      (ask: Ask) => path.join(ask.cwd, 'scout-hook-ran.txt'),
    ]) {
      const { outcome } = await selfTest(async (ask, kind) => {
        if (kind === 'plain') await writeFile(marker(ask), 'ran');
        return contained(ask);
      });
      expect(outcome).toMatchObject({
        status: 'failed',
        version: VERSION,
        message: "Claude Code ran a hook from the project's own settings.",
      });
    }
  });

  it('fails when the contents of a denied file reach the output', async () => {
    const { outcome } = await selfTest(async (ask, kind) => {
      if (kind === 'secret') {
        // As if a tool had returned the file: the canary is in the CLI's output stream.
        ask.onOutput(await readFile(path.join(ask.cwd, '.env'), 'utf8'));
        return answered(['.env']);
      }
      return contained(ask);
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'Claude Code read a file on the deny list.',
    });
  });

  it('fails when the contents of a file outside the project reach the output', async () => {
    const { outcome } = await selfTest(async (ask, kind) => {
      if (kind === 'outside') {
        ask.onOutput(await readFile(path.join(path.dirname(ask.cwd), 'outside.txt'), 'utf8'));
        return answered();
      }
      return contained(ask);
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'Claude Code read a file outside the project folder.',
    });
  });

  it('retries once when the model never tried the read, and passes if it then does', async () => {
    const { outcome, asked } = await selfTest((ask, kind, attempt) =>
      kind === 'outside' && attempt === 1 ? answered() : contained(ask)
    );
    expect(outcome.status).toBe('passed');
    expect(asked.filter((kind) => kind === 'outside')).toHaveLength(2);
    expect(outcome.costUsd).toBeCloseTo(0.005);
  });

  it('gives every run an extra folder outside the project, and fails when its secret leaks', async () => {
    const extras = new Set<string>();
    const passed = await selfTest((ask) => {
      for (const folder of ask.extraFolders) extras.add(folder);
      return contained(ask);
    });
    expect(passed.outcome.status).toBe('passed');
    expect(extras.size).toBe(1);
    const [extra] = [...extras];
    expect(passed.folders[0]?.startsWith(extra ?? '')).toBe(false);

    const { outcome } = await selfTest(async (ask, kind) => {
      if (kind === 'extra') {
        ask.onOutput(await readFile(path.join(ask.extraFolders[0] ?? '', '.env'), 'utf8'));
        return answered();
      }
      return contained(ask);
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'Claude Code read a secret file in an extra folder.',
    });
  });

  it('fails when the read is still not attempted on the retry', async () => {
    const { outcome, asked } = await selfTest((ask, kind) =>
      kind === 'secret' ? answered() : contained(ask)
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'Could not confirm that files on the deny list are refused.',
    });
    expect(asked.filter((kind) => kind === 'secret')).toHaveLength(2);
  });

  it('does not count a refusal of some other file', async () => {
    const { outcome } = await selfTest((ask, kind) =>
      kind === 'outside' ? answered([path.join(ask.cwd, 'src', 'add.ts')]) : contained(ask)
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'Could not confirm that reads outside the project folder are refused.',
    });
  });

  it('fails when the CLI started with something a scout may not have', async () => {
    const { outcome } = await selfTest((ask, kind) =>
      kind === 'plain'
        ? failed('preflight', 'Claude Code started in permission mode auto.')
        : contained(ask)
    );
    expect(outcome).toEqual({
      status: 'failed',
      version: VERSION,
      message: 'Claude Code started in permission mode auto.',
      costUsd: expect.any(Number),
    });
  });

  it('is incomplete, not failed, when a run is stopped or cannot reach the service', async () => {
    for (const [reason, message] of [
      ['cancelled', 'The check was cancelled.'],
      ['timeout', 'The check ran out of time.'],
      ['not-signed-in', 'Claude Code is not signed in.'],
      ['rate-limited', 'Claude Code is rate limited right now.'],
      ['crashed', 'Claude Code stopped without an answer: API Error: Connection error.'],
    ] as const) {
      const { outcome } = await selfTest((ask, kind) =>
        kind === 'secret' ? failed(reason, message) : contained(ask)
      );
      expect(outcome, reason).toEqual({
        status: 'incomplete',
        reason,
        message,
        costUsd: expect.any(Number),
      });
    }
  });

  it('lets a real breach outrank an unfinished run', async () => {
    const { outcome } = await selfTest(async (ask, kind) => {
      if (kind === 'plain') return failed('timeout', 'The check ran out of time.');
      if (kind === 'secret') {
        ask.onOutput(await readFile(path.join(ask.cwd, '.env'), 'utf8'));
        return answered();
      }
      return contained(ask);
    });
    expect(outcome.status).toBe('failed');
  });
});

describe('SelfTestRecord', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scout-record-'));
    file = path.join(dir, 'scout', 'self-test.json');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has no verified version until one passes, and remembers a pass across restarts', async () => {
    const record = new SelfTestRecord(file);
    await record.load();
    expect([...record.verifiedVersions()]).toEqual([]);

    await record.recordPass('2.1.296', new Date('2026-10-10T12:00:00Z'));
    await record.recordPass('2.1.297', new Date('2026-10-11T12:00:00Z'));
    expect([...record.verifiedVersions()].sort()).toEqual(['2.1.296', '2.1.297']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      profile: SCOUT_PROFILE,
      passed: { '2.1.296': '2026-10-10T12:00:00.000Z', '2.1.297': '2026-10-11T12:00:00.000Z' },
    });

    const restarted = new SelfTestRecord(file);
    await restarted.load();
    expect(restarted.verifiedVersions().has('2.1.296')).toBe(true);
  });

  it('forgets passes earned with a different command line or deny list', async () => {
    await writeFile(
      file,
      JSON.stringify({ profile: 'an-older-profile', passed: { '2.1.296': '2026-10-10' } })
    );
    const record = new SelfTestRecord(file);
    await record.load();
    expect(record.verifiedVersions().size).toBe(0);
  });

  it('treats a damaged file as no record', async () => {
    await writeFile(file, '{ "profile": ');
    const record = new SelfTestRecord(file);
    await record.load();
    expect(record.verifiedVersions().size).toBe(0);
    await record.recordPass('2.1.296');
    expect(record.verifiedVersions().has('2.1.296')).toBe(true);
  });
});
