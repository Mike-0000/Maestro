import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '@core/features/claude-accounts/api/types';
import {
  ClaudeAccountMover,
  type ClaudeMoveConversation,
  type ClaudeSessionRestartMode,
} from './claude-account-move';

function account(id: string, loggedIn = true): ClaudeAccount {
  return { id, label: id, kind: id === 'primary' ? 'primary' : 'extra', loggedIn };
}

function conversation(overrides: Partial<ClaudeMoveConversation> = {}): ClaudeMoveConversation {
  return {
    conversationId: 'c1',
    projectId: 'p1',
    taskId: 't1',
    providerId: 'claude',
    type: 'pty',
    host: LOCAL_HOST_REF,
    recordedAccountId: 'primary',
    sessionId: 'session-1',
    automationRun: false,
    inWsl: false,
    ...overrides,
  };
}

function setup(
  options: {
    conversation?: ClaudeMoveConversation | null;
    accounts?: ClaudeAccount[];
    running?: boolean;
    available?: Result<void, string>;
    freshUsage?: string[];
  } = {}
) {
  const stored = {
    value: options.conversation === undefined ? conversation() : options.conversation,
  };
  /** What the recorded account was at each step, as the runtime would see it. */
  const recorded: Array<string | undefined> = [];
  const log: string[] = [];
  const writeAccount = vi.fn(async (_conversation: unknown, accountId: string | undefined) => {
    log.push(`write:${accountId ?? '(none)'}`);
    recorded.push(accountId);
    return ok() as Result<void, string>;
  });
  const restart = vi.fn(
    async (_conversation: unknown, accountId: string, mode: ClaudeSessionRestartMode) => {
      log.push(`restart:${accountId}:${mode}`);
      return ok() as Result<void, string>;
    }
  );
  const sendPrompt = vi.fn(async (_conversation: unknown, text: string) => {
    log.push(`prompt:${text}`);
    return ok() as Result<void, string>;
  });
  const onMoved = vi.fn();
  const mover = new ClaudeAccountMover({
    load: async () => stored.value,
    accounts: {
      list: async () => ({
        accounts: options.accounts ?? [account('primary'), account('work')],
        defaultAccountId: 'primary',
      }),
      resolveAccountId: async (explicit) => explicit ?? 'primary',
      hasFreshUsage: async (accountId) => (options.freshUsage ?? []).includes(accountId),
    },
    writeAccount,
    session: {
      available: async () => options.available ?? ok(),
      isRunning: async () => options.running ?? true,
      restart,
      sendPrompt,
    },
    onMoved,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { mover, stored, log, recorded, writeAccount, restart, sendPrompt, onMoved };
}

describe('ClaudeAccountMover', () => {
  it('records the account, then restarts the running session on it and reports the move', async () => {
    const harness = setup();

    const result = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'manual',
    });

    expect(result).toEqual(
      ok({
        conversationId: 'c1',
        fromAccountId: 'primary',
        toAccountId: 'work',
        restarted: true,
        followUpSent: false,
      })
    );
    expect(harness.log).toEqual(['write:work', 'restart:work:restart']);
    expect(harness.onMoved).toHaveBeenCalledWith({
      conversationId: 'c1',
      projectId: 'p1',
      taskId: 't1',
      fromAccountId: 'primary',
      toAccountId: 'work',
      reason: 'manual',
    });
  });

  it('sends the follow-up only after the session is back', async () => {
    const harness = setup();

    const result = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      followUpPrompt: '  Continue.  ',
      reason: 'limit',
    });

    expect(result.success && result.data.followUpSent).toBe(true);
    expect(harness.log).toEqual(['write:work', 'restart:work:restart', 'prompt:Continue.']);
    expect(harness.onMoved).toHaveBeenCalledWith(expect.objectContaining({ reason: 'limit' }));
  });

  it('only records the account when no session runs and nothing is to be sent', async () => {
    const harness = setup({ running: false, available: err('task closed') });

    const result = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'manual',
    });

    expect(result.success && result.data.restarted).toBe(false);
    expect(harness.log).toEqual(['write:work', 'restart:work:refresh']);
  });

  it('starts a stopped session to deliver a follow-up', async () => {
    const harness = setup({ running: false });

    await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      followUpPrompt: 'Go on',
      reason: 'limit',
    });

    expect(harness.log).toEqual(['write:work', 'restart:work:start', 'prompt:Go on']);
  });

  it('accepts an account flagged signed out whose usage was fetched fresh', async () => {
    const harness = setup({
      accounts: [account('primary'), account('work', false)],
      freshUsage: ['work'],
    });

    const result = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'limit',
    });

    expect(result.success).toBe(true);
  });

  it('treats a conversation without a recorded account as on the primary account', async () => {
    const harness = setup({ conversation: conversation({ recordedAccountId: undefined }) });

    const same = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'primary',
      reason: 'manual',
    });
    const moved = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'manual',
    });

    expect(same).toEqual(err({ type: 'same-account', accountId: 'primary' }));
    expect(moved.success && moved.data.fromAccountId).toBe('primary');
  });

  describe('when the session does not come back', () => {
    it('puts the previous account back and resumes the session there', async () => {
      const harness = setup();
      harness.restart.mockImplementationOnce(async (_c, accountId, mode) => {
        harness.log.push(`restart:${accountId}:${mode}`);
        return err('Claude Code could not find the saved session');
      });

      const result = await harness.mover.move({
        conversationId: 'c1',
        accountId: 'work',
        followUpPrompt: 'Continue',
        reason: 'limit',
      });

      expect(result).toEqual(
        err({
          type: 'restart-failed',
          message: 'Claude Code could not find the saved session',
          restored: true,
        })
      );
      expect(harness.log).toEqual([
        'write:work',
        'restart:work:restart',
        'write:primary',
        'restart:primary:restart',
      ]);
      expect(harness.sendPrompt).not.toHaveBeenCalled();
      expect(harness.onMoved).not.toHaveBeenCalled();
    });

    it('restores a missing account id as missing, and stops what a failed start left', async () => {
      const harness = setup({
        conversation: conversation({ recordedAccountId: undefined }),
        running: false,
      });
      harness.restart.mockImplementationOnce(async () => err('exited'));

      await harness.mover.move({
        conversationId: 'c1',
        accountId: 'work',
        followUpPrompt: 'Continue',
        reason: 'limit',
      });

      expect(harness.recorded).toEqual(['work', undefined]);
      expect(harness.restart.mock.calls.map(([, id, mode]) => `${id}:${mode}`)).toEqual([
        'work:start',
        'primary:stop',
      ]);
    });

    it('says so when the previous account could not be put back', async () => {
      const harness = setup();
      harness.restart.mockResolvedValueOnce(err('exited'));
      harness.writeAccount.mockResolvedValueOnce(ok()).mockResolvedValueOnce(err('host offline'));

      const result = await harness.mover.move({
        conversationId: 'c1',
        accountId: 'work',
        reason: 'manual',
      });

      expect(result).toEqual(err({ type: 'restart-failed', message: 'exited', restored: false }));
      expect(harness.restart).toHaveBeenCalledTimes(1);
    });

    it('reports a failed resume on the previous account as well', async () => {
      const harness = setup();
      harness.restart.mockResolvedValueOnce(err('exited')).mockResolvedValueOnce(err('busy'));

      const result = await harness.mover.move({
        conversationId: 'c1',
        accountId: 'work',
        reason: 'manual',
      });

      expect(result).toEqual(
        err({
          type: 'restart-failed',
          message: 'exited; resuming on the previous account also failed: busy',
          restored: true,
        })
      );
    });
  });

  it('changes nothing when the account cannot be recorded', async () => {
    const harness = setup();
    harness.writeAccount.mockResolvedValueOnce(err('host offline'));

    const result = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'manual',
    });

    expect(result).toEqual(err({ type: 'config-write-failed', message: 'host offline' }));
    expect(harness.restart).not.toHaveBeenCalled();
  });

  it('refuses before changing anything when the session cannot be restarted', async () => {
    const harness = setup({ available: err('Open the task to restart its session') });

    const result = await harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'manual',
    });

    expect(result).toEqual(
      err({ type: 'session-unavailable', message: 'Open the task to restart its session' })
    );
    expect(harness.writeAccount).not.toHaveBeenCalled();
  });

  it.each([
    [{ conversation: null }, 'work', { type: 'conversation-not-found', conversationId: 'c1' }],
    [
      { conversation: conversation({ providerId: 'codex' }) },
      'work',
      { type: 'not-claude-conversation' },
    ],
    [
      { conversation: conversation({ host: { type: 'remote', id: 'box' } }) },
      'work',
      { type: 'not-local' },
    ],
    [{ conversation: conversation({ inWsl: true }) }, 'work', { type: 'not-local' }],
    [{ conversation: conversation({ automationRun: true }) }, 'work', { type: 'unsupported' }],
    [{ conversation: conversation({ taskId: null }) }, 'work', { type: 'unsupported' }],
    [{}, 'gone', { type: 'account-not-found', accountId: 'gone' }],
    [
      { accounts: [account('primary'), account('work', false)] },
      'work',
      { type: 'account-signed-out', accountId: 'work' },
    ],
    [{}, 'primary', { type: 'same-account', accountId: 'primary' }],
  ] as const)('refuses %o to %s', async (options, accountId, expected) => {
    const harness = setup(options as Parameters<typeof setup>[0]);

    const result = await harness.mover.move({ conversationId: 'c1', accountId, reason: 'manual' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatchObject(expected);
    expect(harness.writeAccount).not.toHaveBeenCalled();
    expect(harness.restart).not.toHaveBeenCalled();
  });

  it('runs moves of one conversation one at a time, each seeing the last one finished', async () => {
    const harness = setup();
    let release: () => void = () => {};
    harness.restart.mockImplementationOnce(async (_c, accountId, mode) => {
      harness.log.push(`restart:${accountId}:${mode}`);
      await new Promise<void>((resolve) => (release = resolve));
      return ok();
    });
    // The second move reads the conversation after the first one recorded `work`.
    harness.writeAccount.mockImplementation(async (_c, accountId) => {
      harness.log.push(`write:${accountId ?? '(none)'}`);
      harness.stored.value = conversation({ recordedAccountId: accountId });
      return ok();
    });

    const first = harness.mover.move({ conversationId: 'c1', accountId: 'work', reason: 'limit' });
    const second = harness.mover.move({
      conversationId: 'c1',
      accountId: 'work',
      reason: 'manual',
    });
    await vi.waitFor(() => expect(harness.log).toEqual(['write:work', 'restart:work:restart']));
    release();

    expect((await first).success).toBe(true);
    expect(await second).toEqual(err({ type: 'same-account', accountId: 'work' }));
  });

  it('describes only conversations it may move, with the account they run on', async () => {
    const movable = setup({ conversation: conversation({ recordedAccountId: 'work' }) });
    const other = setup({ conversation: conversation({ providerId: 'codex' }) });

    expect(await movable.mover.describe('c1')).toEqual({
      conversationId: 'c1',
      projectId: 'p1',
      taskId: 't1',
      type: 'pty',
      accountId: 'work',
    });
    expect(await other.mover.describe('c1')).toBeNull();
  });
});
