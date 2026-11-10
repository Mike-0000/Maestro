import { describe, expect, it } from 'vitest';
import {
  agentEventSignal,
  showsPermissionPrompt,
  textHash,
  type AgentSnapshot,
} from './agent-event';

const report = (text: string) => ({ text, truncated: false, appUrls: [] });
const snapshot = (value: Partial<AgentSnapshot>): AgentSnapshot => ({
  status: 'idle',
  report: null,
  notification: null,
  ...value,
});

describe('agentEventSignal', () => {
  it('is null while the agent is idle or working', () => {
    expect(agentEventSignal(snapshot({ status: 'idle' }))).toBeNull();
    expect(agentEventSignal(snapshot({ status: 'working' }))).toBeNull();
  });

  it('keys a finished turn on its reply', () => {
    const a = agentEventSignal(snapshot({ status: 'completed', report: report('Done A') }));
    const again = agentEventSignal(snapshot({ status: 'completed', report: report('Done A') }));
    const b = agentEventSignal(snapshot({ status: 'completed', report: report('Done B') }));
    expect(a).toEqual(again);
    expect(a?.kind).toBe('finished');
    expect(a?.key).not.toBe(b?.key);
    expect(a?.key).not.toContain('Done');
  });

  it('gives a finished turn without a reply a fixed key', () => {
    expect(agentEventSignal(snapshot({ status: 'completed' }))).toEqual({
      kind: 'finished',
      key: 'finished:none',
    });
  });

  it('treats a turn that ended on a question as the same finished turn', () => {
    const completed = agentEventSignal(snapshot({ status: 'completed', report: report('Which?') }));
    const asking = agentEventSignal(
      snapshot({ status: 'awaiting-input', report: report('Which?'), notification: 'idle_prompt' })
    );
    expect(asking).toEqual(completed);
  });

  it('keys a prompt on its notification type, and an error on itself', () => {
    expect(
      agentEventSignal(snapshot({ status: 'awaiting-input', notification: 'permission_prompt' }))
    ).toEqual({ kind: 'awaiting-input', key: 'awaiting-input:permission_prompt' });
    expect(agentEventSignal(snapshot({ status: 'error' }))).toEqual({
      kind: 'error',
      key: 'error',
    });
  });
});

describe('textHash', () => {
  it('is stable and tells texts apart', () => {
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(textHash('abc')).not.toBe(textHash('abd'));
    expect(textHash('')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('showsPermissionPrompt', () => {
  it('holds only for a live permission prompt', () => {
    expect(
      showsPermissionPrompt(
        snapshot({ status: 'awaiting-input', notification: 'permission_prompt' })
      )
    ).toBe(true);
    const not: Partial<AgentSnapshot>[] = [
      { status: 'awaiting-input', notification: 'idle_prompt' },
      // Restored at app start: the status without its notification.
      { status: 'awaiting-input', notification: null },
      // A turn that ended on a question for the developer.
      { status: 'awaiting-input', notification: 'permission_prompt', report: report('Which?') },
      { status: 'working', notification: 'permission_prompt' },
      { status: 'completed' },
      { status: 'idle' },
    ];
    for (const value of not) expect(showsPermissionPrompt(snapshot(value))).toBe(false);
  });
});
