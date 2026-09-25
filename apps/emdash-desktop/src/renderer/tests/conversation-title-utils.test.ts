import { describe, expect, it } from 'vitest';
import {
  AGENT_WINDOW_NAMES,
  agentWindowName,
  formatConversationTitleForDisplay,
  nextDefaultConversationTitle,
  parseAgentWindowNameSlot,
} from '@core/features/conversations/api/browser/conversation-title-utils';

describe('nextDefaultConversationTitle', () => {
  it('names the first window the same way every time', () => {
    expect(nextDefaultConversationTitle([])).toBe('Atlas');
    expect(nextDefaultConversationTitle([])).toBe('Atlas');
  });

  it('assigns the roster in order regardless of provider', () => {
    expect(nextDefaultConversationTitle([{ title: 'Atlas' }])).toBe('Bravo');
    expect(nextDefaultConversationTitle([{ title: 'Atlas' }, { title: 'Bravo' }])).toBe('Cedar');
  });

  it('fills the earliest free slot', () => {
    expect(nextDefaultConversationTitle([{ title: 'Atlas' }, { title: 'Cedar' }])).toBe('Bravo');
  });

  it('ignores custom and legacy numbered titles', () => {
    expect(
      nextDefaultConversationTitle([
        { title: 'release-triage' },
        { title: 'claude (1)' },
        { title: 'Atlas notes' },
      ])
    ).toBe('Atlas');
  });

  it('continues with a numeric cycle after the roster is exhausted', () => {
    const all = AGENT_WINDOW_NAMES.map((title) => ({ title }));
    expect(nextDefaultConversationTitle(all)).toBe('Atlas 2');
    expect(nextDefaultConversationTitle([...all, { title: 'Atlas 2' }])).toBe('Bravo 2');
  });
});

describe('agent window name roster', () => {
  it('has unique names of one or two syllables with unique initials', () => {
    const lower = AGENT_WINDOW_NAMES.map((name) => name.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(new Set(lower.map((name) => name[0])).size).toBe(lower.length);
  });

  it('round-trips slots through names', () => {
    for (const slot of [0, 1, 25, 26, 27, 60]) {
      expect(parseAgentWindowNameSlot(agentWindowName(slot))).toBe(slot);
    }
    expect(parseAgentWindowNameSlot('atlas')).toBe(0);
    expect(parseAgentWindowNameSlot('Atlas 1')).toBeNull();
    expect(parseAgentWindowNameSlot('Claude')).toBeNull();
  });
});

describe('formatConversationTitleForDisplay', () => {
  it('formats existing lowercase legacy default titles for display', () => {
    expect(formatConversationTitleForDisplay('codex', 'codex (2)')).toBe('Codex (2)');
    expect(formatConversationTitleForDisplay('gemini', 'gemini (1)')).toBe('Gemini (1)');
  });

  it('leaves named and custom conversation titles unchanged', () => {
    expect(formatConversationTitleForDisplay('codex', 'Atlas')).toBe('Atlas');
    expect(formatConversationTitleForDisplay('codex', 'release-triage')).toBe('release-triage');
  });
});
