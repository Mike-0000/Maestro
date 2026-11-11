import { describe, expect, it } from 'vitest';
import { CONDUCTOR_REPLY_RULES, CONDUCTOR_RULES, CONDUCTOR_SYSTEM_PROMPT } from './system-prompt';

describe('CONDUCTOR_SYSTEM_PROMPT', () => {
  it('stays byte-stable: no timestamps, dates or per-user values', () => {
    expect(CONDUCTOR_SYSTEM_PROMPT).toBe(`${CONDUCTOR_RULES}\n\n${CONDUCTOR_REPLY_RULES}`);
    expect(CONDUCTOR_SYSTEM_PROMPT).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(CONDUCTOR_SYSTEM_PROMPT).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(CONDUCTOR_SYSTEM_PROMPT).not.toMatch(/\$\{/);
  });

  it('lets the report-back promise follow the Announcements line, mode by mode', () => {
    expect(CONDUCTOR_RULES).toContain(
      'The one exception is reporting back on an agent you started, and only as far as the Announcements line in the context says'
    );
    expect(CONDUCTOR_REPLY_RULES).toContain(
      'When the Announcements line says all finished agents are announced, you may end with "I\'ll tell you when it\'s done or needs you."'
    );
    expect(CONDUCTOR_REPLY_RULES).toContain(
      'when it says only agents that need the developer, you may end with "I\'ll tell you if it needs you."'
    );
    expect(CONDUCTOR_REPLY_RULES).toContain('when it says off, promise nothing');
  });

  it('acts on a yes to its own offer, recommends in choices, and gives the outcome first', () => {
    expect(CONDUCTOR_RULES).toContain(
      'When your last words offered to show something ("Want to see it?") and the developer answers yes'
    );
    expect(CONDUCTOR_REPLY_RULES).toContain('ask so that a yes takes your pick');
    expect(CONDUCTOR_REPLY_RULES).toContain('Give the outcome first.');
    expect(CONDUCTOR_REPLY_RULES).toContain(
      'After a successful spawn, reply in one or two short sentences'
    );
  });
});
