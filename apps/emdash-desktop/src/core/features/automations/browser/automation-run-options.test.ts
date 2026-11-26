import { describe, expect, it } from 'vitest';
import type { AgentCapabilities } from '@core/primitives/agents/api';
import {
  conversationConfigSchema,
  type ConversationConfig,
} from '@core/primitives/automations/api';
import {
  automationEffortOptions,
  buildAutomationConversationConfig,
  formatCloseTimeout,
  normalizeCloseTimeoutMinutes,
  resolveAutomationEffort,
  runOptionsFromConversationConfig,
  splitCloseTimeout,
} from './automation-run-options';

function capabilities(effort: unknown): AgentCapabilities {
  return { effort } as unknown as AgentCapabilities;
}

const claudeEffort = {
  kind: 'selectable',
  effortOptions: {
    max: { label: 'Max', level: 5 },
    low: { label: 'Low', level: 1 },
    xhigh: { label: 'Extra high', level: 4 },
    medium: { label: 'Medium', level: 2 },
    high: { label: 'High', level: 3 },
  },
};

/** Rebuilds a stored config the way the form does: seed the run options, then save. */
function roundTrip(stored: ConversationConfig): ConversationConfig {
  return buildAutomationConversationConfig({
    prompt: stored.prompt,
    provider: stored.provider,
    model: stored.model ?? null,
    useChatUi: stored.type === 'acp',
    title: stored.title,
    ...runOptionsFromConversationConfig(stored),
  });
}

describe('automationEffortOptions', () => {
  it('lists the agent levels lowest first', () => {
    expect(automationEffortOptions(capabilities(claudeEffort))).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' },
    ]);
  });

  it('is null when the agent offers no effort', () => {
    expect(automationEffortOptions(capabilities({ kind: 'none' }))).toBeNull();
    expect(
      automationEffortOptions(capabilities({ kind: 'selectable', effortOptions: {} }))
    ).toBeNull();
    // An older host build: the capability says selectable but carries no options.
    expect(automationEffortOptions(capabilities({ kind: 'selectable' }))).toBeNull();
    expect(automationEffortOptions(capabilities(undefined))).toBeNull();
    expect(automationEffortOptions(null)).toBeNull();
    expect(automationEffortOptions(undefined)).toBeNull();
  });

  it('falls back to the id for a level with no label', () => {
    expect(
      automationEffortOptions(
        capabilities({ kind: 'selectable', effortOptions: { turbo: { level: 1 }, calm: {} } })
      )
    ).toEqual([
      { id: 'turbo', label: 'turbo' },
      { id: 'calm', label: 'calm' },
    ]);
  });
});

describe('resolveAutomationEffort', () => {
  const options = automationEffortOptions(capabilities(claudeEffort));

  it('keeps an effort the agent offers', () => {
    expect(resolveAutomationEffort('max', options)).toBe('max');
  });

  it('drops an effort the agent does not offer', () => {
    expect(resolveAutomationEffort('ludicrous', options)).toBeNull();
    expect(resolveAutomationEffort('max', null)).toBeNull();
  });

  it('treats empty as the agent default', () => {
    expect(resolveAutomationEffort('', options)).toBeNull();
    expect(resolveAutomationEffort(null, options)).toBeNull();
    expect(resolveAutomationEffort(undefined, options)).toBeNull();
  });
});

describe('runOptionsFromConversationConfig', () => {
  it('opens an automation saved before the options existed with all of them empty', () => {
    expect(
      runOptionsFromConversationConfig({ prompt: 'p', provider: 'claude', autoApprove: false })
    ).toEqual({ effort: null, closeWhenDone: false, closeTimeoutMinutes: null });
    expect(runOptionsFromConversationConfig(undefined)).toEqual({
      effort: null,
      closeWhenDone: false,
      closeTimeoutMinutes: null,
    });
  });

  it('reads the stored effort and close-when-done', () => {
    expect(
      runOptionsFromConversationConfig({
        prompt: 'p',
        provider: 'claude',
        autoApprove: false,
        effort: 'max',
        closeWhenDone: { timeoutMinutes: 90 },
      })
    ).toEqual({ effort: 'max', closeWhenDone: true, closeTimeoutMinutes: 90 });
  });

  it('reads close-when-done with the default time limit', () => {
    expect(
      runOptionsFromConversationConfig({
        prompt: 'p',
        provider: 'claude',
        autoApprove: false,
        closeWhenDone: {},
      })
    ).toEqual({ effort: null, closeWhenDone: true, closeTimeoutMinutes: null });
  });
});

describe('buildAutomationConversationConfig', () => {
  const base = {
    prompt: '  Review open pull requests  ',
    provider: 'claude',
    model: null,
    useChatUi: false,
    effort: null,
    closeWhenDone: false,
    closeTimeoutMinutes: null,
  };

  it('writes neither option when none is set', () => {
    const config = buildAutomationConversationConfig(base);
    expect(config).toEqual({
      prompt: 'Review open pull requests',
      provider: 'claude',
      autoApprove: false,
      type: 'pty',
    });
    expect(Object.keys(config)).not.toContain('effort');
    expect(Object.keys(config)).not.toContain('closeWhenDone');
    expect(Object.keys(config)).not.toContain('model');
    expect(Object.keys(config)).not.toContain('title');
  });

  it('writes the chosen effort', () => {
    expect(buildAutomationConversationConfig({ ...base, effort: 'max' }).effort).toBe('max');
  });

  it('writes an empty close-when-done for the default time limit', () => {
    const config = buildAutomationConversationConfig({ ...base, closeWhenDone: true });
    expect(config.closeWhenDone).toEqual({});
  });

  it('writes the time limit when one is set', () => {
    const config = buildAutomationConversationConfig({
      ...base,
      closeWhenDone: true,
      closeTimeoutMinutes: 390,
    });
    expect(config.closeWhenDone).toEqual({ timeoutMinutes: 390 });
  });

  it('leaves close-when-done out while the switch is off, whatever time limit was typed', () => {
    const config = buildAutomationConversationConfig({ ...base, closeTimeoutMinutes: 390 });
    expect(Object.keys(config)).not.toContain('closeWhenDone');
  });

  it('never writes a time limit the schema would reject', () => {
    for (const closeTimeoutMinutes of [0, -5, Number.NaN, 12.7]) {
      const config = buildAutomationConversationConfig({
        ...base,
        closeWhenDone: true,
        closeTimeoutMinutes,
      });
      expect(conversationConfigSchema.safeParse(config).success).toBe(true);
    }
    expect(
      buildAutomationConversationConfig({ ...base, closeWhenDone: true, closeTimeoutMinutes: 12.7 })
        .closeWhenDone
    ).toEqual({ timeoutMinutes: 12 });
  });

  it('carries the model, transport and stored title', () => {
    expect(
      buildAutomationConversationConfig({
        ...base,
        model: 'opus',
        useChatUi: true,
        title: 'Nightly research',
      })
    ).toEqual({
      prompt: 'Review open pull requests',
      provider: 'claude',
      autoApprove: false,
      type: 'acp',
      model: 'opus',
      title: 'Nightly research',
    });
  });
});

describe('saving an existing automation unchanged', () => {
  const stored: ConversationConfig[] = [
    { prompt: 'Review open pull requests', provider: 'claude', autoApprove: false, type: 'pty' },
    {
      prompt: 'Summarise the week',
      provider: 'codex',
      autoApprove: false,
      type: 'acp',
      model: 'gpt-5',
      title: 'Weekly summary',
    },
    {
      prompt: 'Deep research',
      provider: 'claude',
      autoApprove: false,
      type: 'acp',
      model: 'opus',
      effort: 'max',
      closeWhenDone: {},
    },
    {
      prompt: 'Deep research',
      provider: 'claude',
      autoApprove: false,
      type: 'pty',
      effort: 'high',
      closeWhenDone: { timeoutMinutes: 45 },
    },
  ];

  it.each(stored)('rebuilds exactly the stored config (%#)', (config) => {
    const rebuilt = roundTrip(config);
    expect(rebuilt).toEqual(config);
    // toEqual ignores undefined members; the key sets must match too, so a deployment built
    // from the saved automation is the one it had.
    expect(Object.keys(rebuilt).sort()).toEqual(Object.keys(config).sort());
  });
});

describe('time limit helpers', () => {
  it('normalizes to whole positive minutes or the default', () => {
    expect(normalizeCloseTimeoutMinutes(240)).toBe(240);
    expect(normalizeCloseTimeoutMinutes(1.9)).toBe(1);
    expect(normalizeCloseTimeoutMinutes(0)).toBeNull();
    expect(normalizeCloseTimeoutMinutes(-1)).toBeNull();
    expect(normalizeCloseTimeoutMinutes(Number.NaN)).toBeNull();
    expect(normalizeCloseTimeoutMinutes(null)).toBeNull();
    expect(normalizeCloseTimeoutMinutes(undefined)).toBeNull();
  });

  it('splits into hours and minutes that add back up', () => {
    expect(splitCloseTimeout(240)).toEqual({ hours: 4, minutes: 0 });
    expect(splitCloseTimeout(390)).toEqual({ hours: 6, minutes: 30 });
    expect(splitCloseTimeout(45)).toEqual({ hours: 0, minutes: 45 });
    for (const total of [1, 59, 60, 61, 1439, 59_999]) {
      const { hours, minutes } = splitCloseTimeout(total);
      expect(hours * 60 + minutes).toBe(total);
    }
  });

  it('words a time limit', () => {
    expect(formatCloseTimeout(240)).toBe('4 h');
    expect(formatCloseTimeout(390)).toBe('6 h 30 min');
    expect(formatCloseTimeout(45)).toBe('45 min');
  });
});
