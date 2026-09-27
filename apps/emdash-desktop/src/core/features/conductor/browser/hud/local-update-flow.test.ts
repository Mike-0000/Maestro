import { describe, expect, it, vi } from 'vitest';
import type { LocalUpdateStatus } from '@core/features/local-updates/api';
import type { LocalUpdatesClient } from '@core/features/local-updates/api/browser/client';
import { runLocalUpdateFlow } from './local-update-flow';

const id = '11111111-1111-4111-8111-111111111111';

function fixture(initialState: string | null = null) {
  let state = initialState;
  const calls: string[] = [];
  const snapshot = () =>
    ({
      enabled: true,
      lastError: state === 'blocked' ? 'workspace-static-check failed: format' : null,
      candidate: state && {
        id,
        state,
        eligible: true,
        included: [{ taskId: 'task-1', taskName: 'Ready change', commit: 'a'.repeat(40) }],
        error: null,
        validation: state === 'blocked' ? { error: 'workspace-static-check failed: format' } : null,
      },
    }) as LocalUpdateStatus;
  const client = {
    status: vi.fn(async () => ({ success: true as const, data: snapshot() })),
    prepare: vi.fn(async (_input: unknown, options: { timeoutMs?: number }) => {
      expect(options).toEqual({ timeoutMs: 0 });
      calls.push('prepare');
      state = 'integrated';
      return { success: true as const, data: {} };
    }),
    validate: vi.fn(async (_input: unknown, options: { timeoutMs?: number }) => {
      calls.push('validate');
      expect(options).toEqual({ timeoutMs: 0 });
      // Validation takes longer than Wire's default 30s deadline; only the call override prevents it.
      state = 'validated';
      return { success: true as const, data: { validated: true } };
    }),
    promote: vi.fn(async () => {
      calls.push('promote');
      state = 'promoted';
      return { success: true as const, data: {} };
    }),
    schedule: vi.fn(async (_input: unknown, options: { timeoutMs?: number }) => {
      expect(options).toEqual({ timeoutMs: 0 });
      calls.push('schedule');
      state = 'applying';
      return { success: true as const, data: {} };
    }),
  } as unknown as LocalUpdatesClient;
  return {
    client,
    calls,
    snapshot,
    setState(next: string) {
      state = next;
    },
  };
}

describe('one-button local update flow', () => {
  it('prepares, validates without a 30s deadline, confirms promotion and scheduling separately', async () => {
    const test = fixture();
    const stages: string[] = [];
    const confirmPromote = vi.fn(async () => true);
    const confirmSchedule = vi.fn(async () => true);
    await runLocalUpdateFlow(test.client, 'project-1', {
      confirmPromote,
      confirmSchedule,
      onStage: (stage) => stages.push(stage),
    });
    expect(test.calls).toEqual(['prepare', 'validate', 'promote', 'schedule']);
    expect(stages).toHaveLength(4);
    expect(confirmPromote).toHaveBeenCalledWith(expect.objectContaining({ state: 'validated' }));
    expect(confirmSchedule).toHaveBeenCalledWith(expect.objectContaining({ state: 'promoted' }));
  });

  it('resumes at the confirmed step and never schedules when confirmation is declined', async () => {
    const test = fixture('validated');
    await runLocalUpdateFlow(test.client, 'project-1', {
      confirmPromote: async () => false,
      confirmSchedule: async () => true,
      onStage: () => {},
    });
    expect(test.calls).toEqual([]);
    await runLocalUpdateFlow(test.client, 'project-1', {
      confirmPromote: async () => true,
      confirmSchedule: async () => false,
      onStage: () => {},
    });
    expect(test.calls).toEqual(['promote']);
    expect(test.snapshot().candidate?.state).toBe('promoted');
  });

  it('stops on failed validation rather than promoting an unverified package', async () => {
    const test = fixture('integrated');
    test.client.validate = vi.fn(async () => ({
      success: false as const,
      error: { message: 'Build failed' },
    }));
    await expect(
      runLocalUpdateFlow(test.client, 'project-1', {
        confirmPromote: async () => true,
        confirmSchedule: async () => true,
        onStage: () => {},
      })
    ).rejects.toThrow('Build failed');
    expect(test.calls).toEqual([]);
  });

  it('surfaces lastError when validation leaves the candidate blocked without candidate.error', async () => {
    const test = fixture('integrated');
    test.client.validate = vi.fn(async () => {
      test.setState('blocked');
      return { success: true as const, data: { validated: false, state: 'blocked' } };
    });
    await expect(
      runLocalUpdateFlow(test.client, 'project-1', {
        confirmPromote: async () => true,
        confirmSchedule: async () => true,
        onStage: () => {},
      })
    ).rejects.toThrow('workspace-static-check failed: format');
  });
});
