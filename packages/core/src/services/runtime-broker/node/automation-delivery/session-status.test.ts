import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '#runtimes/acp/api';
import type { TuiAgentState, TuiSessionState } from '#runtimes/tui-agents/api';
import { acpSessionStatus, tuiSessionStatus } from './session-status';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    conversationId: 'conv-1',
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: false,
    lastStopReason: null,
    lastTurnErrored: false,
    pendingPermissionCount: 0,
    backgroundAgentCount: 0,
    queuedPromptCount: 0,
    title: null,
    updatedAt: 0,
    ...overrides,
  };
}

function agent(status: TuiAgentState['status']): TuiAgentState {
  return { conversationId: 'conv-1', status, updatedAt: 0 };
}

describe('acpSessionStatus', () => {
  it('is unknown before the runtime reports the session', () => {
    expect(acpSessionStatus(undefined).state).toBe('unknown');
  });

  it('is working until a turn has produced an outcome', () => {
    expect(acpSessionStatus(summary({ lifecycle: 'starting' })).state).toBe('working');
    expect(acpSessionStatus(summary()).state).toBe('working');
    expect(
      acpSessionStatus(summary({ lastStopReason: 'end_turn', isGenerating: true })).state
    ).toBe('working');
    expect(
      acpSessionStatus(summary({ lastStopReason: 'end_turn', queuedPromptCount: 1 })).state
    ).toBe('working');
  });

  it('is settled and clean after a normal end of turn, even once the session closes', () => {
    expect(acpSessionStatus(summary({ lastStopReason: 'end_turn' }))).toMatchObject({
      state: 'settled',
      clean: true,
    });
    expect(
      acpSessionStatus(summary({ lastStopReason: 'end_turn', lifecycle: 'closed' }))
    ).toMatchObject({ state: 'settled', clean: true });
  });

  it('is settled but not clean after an abnormal stop', () => {
    for (const lastStopReason of ['max_tokens', 'refusal', 'cancelled'] as const) {
      expect(acpSessionStatus(summary({ lastStopReason }))).toMatchObject({
        state: 'settled',
        clean: false,
      });
    }
    expect(acpSessionStatus(summary({ lastTurnErrored: true }))).toMatchObject({
      state: 'settled',
      clean: false,
      detail: 'turn_errored',
    });
  });

  it('is exited when the session closed without an outcome', () => {
    expect(acpSessionStatus(summary({ lifecycle: 'closed' })).state).toBe('exited');
  });
});

describe('tuiSessionStatus', () => {
  const session = { conversationId: 'conv-1' } as TuiSessionState;

  it('is unknown without any report', () => {
    expect(tuiSessionStatus(undefined, undefined).state).toBe('unknown');
    expect(tuiSessionStatus(undefined, session).state).toBe('unknown');
  });

  it('maps agent statuses', () => {
    expect(tuiSessionStatus(agent('working'), session).state).toBe('working');
    expect(tuiSessionStatus(agent('idle'), session)).toMatchObject({
      state: 'settled',
      clean: true,
    });
    expect(tuiSessionStatus(agent('awaiting-input'), session)).toMatchObject({
      state: 'settled',
      clean: false,
    });
    expect(tuiSessionStatus(agent('error'), session)).toMatchObject({
      state: 'settled',
      clean: false,
    });
  });

  it('is exited when the process ended without completing', () => {
    const exited = { ...session, exit: { exitCode: 1 } } as TuiSessionState;

    expect(tuiSessionStatus(agent('working'), exited)).toMatchObject({
      state: 'exited',
      detail: 'exit_1',
    });
    expect(tuiSessionStatus(agent('completed'), exited)).toMatchObject({
      state: 'settled',
      clean: true,
    });
  });
});
