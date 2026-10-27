import { describe, expect, it, vi } from 'vitest';
import { FakePtySpawner } from '#services/pty/testing';
import { PtyRegistry } from './pty-registry';
import { PTY_OUTPUT_BATCH_MAX_CHARS, PTY_OUTPUT_BATCH_MS } from './pty-session';
import type { PtySpawnSpec } from './types';

const spec: PtySpawnSpec = {
  invocation: { kind: 'argv', executable: 'claude', argv: ['auth', 'login'] },
  cwd: '/tmp',
  env: { PATH: '/bin' },
  cols: 120,
  rows: 30,
};

describe('PtyRegistry', () => {
  it('spawns a session and streams output into a LiveLogSource', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);

    const session = await registry.create('auth:claude', spec);
    spawner.processes[0]!.emitData('hello');
    spawner.processes[0]!.emitData(' world');

    expect(spawner.specs).toEqual([spec]);
    expect(registry.get('auth:claude')).toBe(session);
    await vi.waitFor(() => {
      expect(registry.getLog('auth:claude')?.snapshot().data.text).toBe('hello world');
    });
  });

  it('forwards input, resize, and kill to the process', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);

    await registry.create('auth:claude', spec);
    registry.write('auth:claude', 'abc');
    registry.resize('auth:claude', 80, 24);
    registry.kill('auth:claude');

    expect(spawner.processes[0]!.writes).toEqual(['abc']);
    expect(spawner.processes[0]!.resizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(spawner.processes[0]!.killCount).toBeGreaterThan(0);
  });

  it('tracks exit status and notifies registry changes', async () => {
    const spawner = new FakePtySpawner();
    const onSessionChanged = vi.fn();
    const registry = new PtyRegistry(spawner, { onSessionChanged });

    const session = await registry.create('auth:claude', spec);
    spawner.processes[0]!.emitExit({ exitCode: 0, signal: null });

    expect(session.exitStatus).toEqual({ exitCode: 0, signal: null });
    expect(onSessionChanged).toHaveBeenLastCalledWith('auth:claude', session);
  });

  it('replaces an existing session by default', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);

    await registry.create('auth:claude', spec);
    await registry.create('auth:claude', {
      ...spec,
      invocation: { kind: 'argv', executable: 'claude', argv: [] },
    });

    expect(spawner.processes[0]!.killCount).toBeGreaterThan(0);
    expect(spawner.processes).toHaveLength(2);
    expect(registry.get('auth:claude')?.spec.invocation).toEqual({
      kind: 'argv',
      executable: 'claude',
      argv: [],
    });
  });
});

describe('PtySession output batching', () => {
  it('appends a burst of output as one log update after the batch window', async () => {
    vi.useFakeTimers();
    try {
      const spawner = new FakePtySpawner();
      const registry = new PtyRegistry(spawner);
      const session = await registry.create('auth:claude', spec);
      const updates: unknown[] = [];
      session.output.subscribe((update) => updates.push(update));

      spawner.processes[0]!.emitData('a');
      spawner.processes[0]!.emitData('b');
      spawner.processes[0]!.emitData('c');
      expect(updates).toHaveLength(0);

      vi.advanceTimersByTime(PTY_OUTPUT_BATCH_MS);
      expect(updates).toHaveLength(1);
      expect(session.output.snapshot().data.text).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends at once when a batch grows past its size cap', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);
    const session = await registry.create('auth:claude', spec);

    spawner.processes[0]!.emitData('x'.repeat(PTY_OUTPUT_BATCH_MAX_CHARS));

    expect(session.output.snapshot().data.text).toHaveLength(PTY_OUTPUT_BATCH_MAX_CHARS);
  });

  it('flushes batched output before reporting exit', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);
    let textAtExit: string | undefined;
    const session = await registry.create('auth:claude', spec, {
      onExit: () => {
        textAtExit = session.output.snapshot().data.text;
      },
    });

    spawner.processes[0]!.emitData('bye');
    spawner.processes[0]!.emitExit();

    expect(textAtExit).toBe('bye');
  });

  it('flushes batched output when the session is replaced', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);
    const first = await registry.create('auth:claude', spec);

    spawner.processes[0]!.emitData('old');
    await registry.create('auth:claude', spec);

    expect(first.output.snapshot().data.text).toBe('old');
  });

  it('appends every piece at once when batching is off', async () => {
    const spawner = new FakePtySpawner();
    const registry = new PtyRegistry(spawner);
    const session = await registry.create('auth:claude', spec, { outputBatchMs: 0 });

    spawner.processes[0]!.emitData('now');

    expect(session.output.snapshot().data.text).toBe('now');
  });
});
