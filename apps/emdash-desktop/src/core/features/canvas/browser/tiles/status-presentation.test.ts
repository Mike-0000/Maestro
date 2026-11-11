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

  it('draws each state with the kit mark the sidebar uses', () => {
    const at = (status: 'working' | 'awaiting-input' | 'error' | 'completed' | 'idle') =>
      statusPresentation({ status, notificationType: null, seen: false }).glyph;
    expect(at('working')).toBe('working');
    expect(at('awaiting-input')).toBe('needs-you');
    expect(at('error')).toBe('error');
    expect(at('completed')).toBe('unread');
    expect(at('idle')).toBe('idle');
  });

  it('follows the ownership rule: a waiting agent stays yours after it is seen', () => {
    const seen = (status: 'awaiting-input' | 'completed' | 'error' | 'working') =>
      statusPresentation({ status, notificationType: null, seen: true });
    expect(seen('awaiting-input').yours).toBe(true);
    expect(seen('awaiting-input').glyph).toBe('needs-you');
    expect(seen('completed').yours).toBe(false);
    expect(seen('completed').glyph).toBe('done');
    expect(seen('error').yours).toBe(false);
    expect(seen('working').yours).toBe(false);
    expect(
      statusPresentation({ status: 'completed', notificationType: null, seen: false }).yours
    ).toBe(true);
  });

  it('says when the wait is for a permission', () => {
    expect(
      statusPresentation({ status: 'awaiting-input', notificationType: 'permission_prompt' }).label
    ).toBe('Needs permission');
  });
});
