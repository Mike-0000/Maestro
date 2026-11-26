import { describe, expect, it } from 'vitest';
import { acpSessionLaunchInputSchema, tuiSessionStartInputSchema } from './schemas';

const tuiStart = {
  conversationId: 'conversation-1',
  providerId: 'claude',
  cwd: '/workspace',
  sessionId: null,
  model: null,
  initialPrompt: 'Review this repository',
  autoApprove: true,
  cols: 80,
  rows: 24,
};

const acpLaunch = {
  conversationId: 'conversation-1',
  providerId: 'claude',
  cwd: '/workspace',
  sessionId: null,
  model: null,
  initialQueue: [{ text: 'Review this repository' }],
};

describe('session-start effort', () => {
  it('parses inputs without an effort exactly as before', () => {
    expect(tuiSessionStartInputSchema.parse(tuiStart)).toEqual(tuiStart);
    expect(acpSessionLaunchInputSchema.parse(acpLaunch)).toEqual(acpLaunch);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', null])('accepts the effort %s', (effort) => {
    expect(tuiSessionStartInputSchema.parse({ ...tuiStart, effort }).effort).toBe(effort);
    expect(acpSessionLaunchInputSchema.parse({ ...acpLaunch, effort }).effort).toBe(effort);
  });

  it.each(['', ' ', '--dangerously-skip-permissions', '-x', 'high max', 'high\nmax'])(
    'rejects a terminal effort that is not a plain token (%j)',
    (effort) => {
      expect(tuiSessionStartInputSchema.safeParse({ ...tuiStart, effort }).success).toBe(false);
    }
  );

  it('rejects a blank ACP effort', () => {
    expect(acpSessionLaunchInputSchema.safeParse({ ...acpLaunch, effort: ' ' }).success).toBe(
      false
    );
  });
});
