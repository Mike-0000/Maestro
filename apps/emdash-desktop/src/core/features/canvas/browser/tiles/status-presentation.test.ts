import { describe, expect, it } from 'vitest';
import { statusPresentation } from './status-presentation';

describe('statusPresentation', () => {
  it('names the subagents a working agent is waiting on', () => {
    const working = { status: 'working', notificationType: null } as const;
    expect(statusPresentation({ ...working, backgroundAgents: 6 }).label).toBe(
      'Working · 6 sub-agents'
    );
    expect(statusPresentation({ ...working, backgroundAgents: 1 }).label).toBe(
      'Working · 1 sub-agent'
    );
    expect(statusPresentation(working).label).toBe('Working');
  });
});
