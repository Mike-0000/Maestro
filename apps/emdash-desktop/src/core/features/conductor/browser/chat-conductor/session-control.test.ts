import { describe, expect, it, vi } from 'vitest';
import {
  restartChatAgent,
  stopChatAgent,
  type MoveOutcome,
  type SessionControlDeps,
} from './session-control';

const primary = { id: 'primary', label: 'Primary' };
const work = { id: 'a1', label: 'Work' };

function control(overrides: Partial<SessionControlDeps> = {}) {
  let running = true;
  const steps: string[] = [];
  const moved = (
    data: Partial<Extract<MoveOutcome, { success: true }>['data']> = {}
  ): MoveOutcome => ({
    success: true,
    data: {
      conversationId: 'conv-1',
      fromAccountId: 'primary',
      toAccountId: 'a1',
      restarted: true,
      followUpSent: false,
      ...data,
    },
  });
  const deps: SessionControlDeps = {
    kind: 'pty',
    agentLabel: 'Claude Code',
    running: () => running,
    stop: vi.fn(async () => {
      steps.push('stop');
      running = false;
    }),
    stopped: vi.fn(async () => !running),
    start: vi.fn(async () => {
      steps.push('start');
      running = true;
      return true;
    }),
    deliver: vi.fn(async (prompt: string) => {
      steps.push(`deliver:${prompt}`);
      return true;
    }),
    currentAccount: () => primary,
    resolveAccount: (reference) =>
      reference.toLowerCase().includes('work')
        ? { ok: true, account: work }
        : reference.toLowerCase().includes('primary')
          ? { ok: true, account: primary }
          : { ok: false, message: `No Claude account matches "${reference}".` },
    move: vi.fn(async (_accountId: string, prompt: string | undefined) => {
      steps.push('move');
      return moved({ followUpSent: prompt !== undefined });
    }),
    describeMoveError: (error, target, previous) =>
      `Couldn't continue on ${target} (${error.type}); was on ${previous}.`,
    ...overrides,
  };
  return { deps, steps, moved, setRunning: (value: boolean) => (running = value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('restartChatAgent', () => {
  it('stops a running session, then starts it again on the same conversation', async () => {
    const { deps, steps } = control();
    const late = vi.fn();
    const result = await restartChatAgent(deps, {}, late);
    expect(steps).toEqual(['stop', 'start']);
    expect(result).toContain('Stopped the session and started it again');
    expect(deps.move).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it('only starts a session that was not running', async () => {
    const { deps, steps, setRunning } = control();
    setRunning(false);
    const result = await restartChatAgent(deps, {}, vi.fn());
    expect(steps).toEqual(['start']);
    expect(result).toContain('was not running; started it');
  });

  it('sends the prompt after the restart without waiting, and reports one that did not arrive', async () => {
    const { deps, steps } = control();
    expect(await restartChatAgent(deps, { prompt: 'Carry on.' }, vi.fn())).toContain(
      'The prompt is typed once it takes input'
    );
    await settle();
    expect(steps).toEqual(['stop', 'start', 'deliver:Carry on.']);

    const late = vi.fn();
    const lost = control({ deliver: vi.fn(async () => false) });
    await restartChatAgent(lost.deps, { prompt: 'Carry on.' }, late);
    await settle();
    expect(late).toHaveBeenCalledWith('The restarted agent did not take the prompt.');
    const thrown = control({
      deliver: vi.fn(async () => {
        throw new Error('held too long');
      }),
    });
    await restartChatAgent(thrown.deps, { prompt: 'Carry on.' }, late);
    await settle();
    expect(late).toHaveBeenLastCalledWith(
      'The restarted agent did not take the prompt: held too long'
    );
  });

  it('does not start a session that would not stop, and says when it did not come back', async () => {
    const stuck = control({ stopped: vi.fn(async () => false) });
    await expect(restartChatAgent(stuck.deps, {}, vi.fn())).rejects.toThrow(
      'still shows it running'
    );
    expect(stuck.steps).toEqual(['stop']);

    const dead = control({ start: vi.fn(async () => false) });
    await expect(restartChatAgent(dead.deps, {}, vi.fn())).rejects.toThrow(
      'did not start again. The conversation is kept.'
    );
  });

  it('ends a chat agent and lets its next prompt start it', async () => {
    const { deps, steps } = control({ kind: 'acp' });
    expect(await restartChatAgent(deps, {}, vi.fn())).toContain('with its next prompt');
    expect(steps).toEqual(['stop']);
    expect(deps.start).not.toHaveBeenCalled();

    const prompted = control({ kind: 'acp' });
    expect(await restartChatAgent(prompted.deps, { prompt: 'Go on.' }, vi.fn())).toContain(
      'Ended the session and sent the prompt'
    );
    expect(prompted.steps).toEqual(['stop', 'deliver:Go on.']);
  });

  it('moves the chat to another account through the move, not by stopping it itself', async () => {
    const { deps, steps } = control();
    const result = await restartChatAgent(deps, { claudeAccount: 'my work account' }, vi.fn());
    expect(steps).toEqual(['move']);
    expect(deps.move).toHaveBeenCalledWith('a1', undefined);
    expect(result).toBe(
      'Stopped the session and resumed the conversation on Work (it was on Primary).'
    );

    const prompted = control();
    const sent = await restartChatAgent(
      prompted.deps,
      { claudeAccount: 'Work', prompt: 'Carry on.' },
      vi.fn()
    );
    expect(prompted.deps.move).toHaveBeenCalledWith('a1', 'Carry on.');
    expect(sent).toContain('The prompt was sent.');
    expect(prompted.steps).toEqual(['move']);
  });

  it('says what a move left undone', async () => {
    const idle = control();
    idle.setRunning(false);
    idle.deps.move = vi.fn(async () => idle.moved({ restarted: false }));
    expect(await restartChatAgent(idle.deps, { claudeAccount: 'Work' }, vi.fn())).toContain(
      'was not running and was not started'
    );

    const unsent = control();
    unsent.deps.move = vi.fn(async () => unsent.moved({ followUpSent: false }));
    expect(
      await restartChatAgent(unsent.deps, { claudeAccount: 'Work', prompt: 'Carry on.' }, vi.fn())
    ).toContain('The prompt was not delivered');
  });

  it('changes nothing for an account it cannot use', async () => {
    const unknown = control();
    await expect(
      restartChatAgent(unknown.deps, { claudeAccount: 'Nope' }, vi.fn())
    ).rejects.toThrow('No Claude account matches "Nope". Nothing was changed.');
    expect(unknown.steps).toEqual([]);

    const codex = control({ agentLabel: 'Codex', currentAccount: () => null });
    await expect(restartChatAgent(codex.deps, { claudeAccount: 'Work' }, vi.fn())).rejects.toThrow(
      "this chat's agent is Codex"
    );
    expect(codex.steps).toEqual([]);

    const failed = control({
      move: vi.fn(async () => ({
        success: false as const,
        error: { type: 'account-signed-out' as const, accountId: 'a1' },
      })),
    });
    await expect(restartChatAgent(failed.deps, { claudeAccount: 'Work' }, vi.fn())).rejects.toThrow(
      "Couldn't continue on Work (account-signed-out); was on Primary."
    );
  });

  it('restarts in place when asked for the account the agent is already on', async () => {
    const { deps, steps } = control();
    const result = await restartChatAgent(deps, { claudeAccount: 'Primary' }, vi.fn());
    expect(steps).toEqual(['stop', 'start']);
    expect(deps.move).not.toHaveBeenCalled();
    expect(result).toContain('already runs on Primary');
  });
});

describe('stopChatAgent', () => {
  it('stops a running session and keeps the conversation', async () => {
    const { deps, steps } = control();
    expect(await stopChatAgent(deps)).toContain('Stopped the session');
    expect(steps).toEqual(['stop']);
  });

  it('does nothing when it is not running, and says when the stop did not take', async () => {
    const idle = control();
    idle.setRunning(false);
    expect(await stopChatAgent(idle.deps)).toContain('not running');
    expect(idle.steps).toEqual([]);

    const stuck = control({ stopped: vi.fn(async () => false) });
    await expect(stopChatAgent(stuck.deps)).rejects.toThrow('still shows it running');
  });
});
