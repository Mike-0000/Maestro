import { describe, expect, it } from 'vitest';
import { automationConversationConfig, type ConversationConfig } from './config';

const base: ConversationConfig = {
  prompt: 'Review the latest changes',
  provider: 'claude',
  autoApprove: false,
  model: 'sonnet',
  type: 'acp',
};

function roundTrip(config: ConversationConfig): ConversationConfig | null {
  return automationConversationConfig.parseJson(automationConversationConfig.serialize(config));
}

describe('automationConversationConfig', () => {
  it('round-trips a stored config without effort or close-when-done unchanged', () => {
    const parsed = roundTrip(base);

    expect(parsed).toStrictEqual(base);
  });

  it('round-trips effort and close-when-done', () => {
    const config: ConversationConfig = {
      ...base,
      effort: 'high',
      closeWhenDone: { timeoutMinutes: 90 },
    };

    expect(roundTrip(config)).toStrictEqual(config);
    expect(roundTrip({ ...base, closeWhenDone: {} })).toStrictEqual({
      ...base,
      closeWhenDone: {},
    });
  });

  it('rejects a non-positive close timeout', () => {
    const raw = JSON.stringify({ ...base, closeWhenDone: { timeoutMinutes: 0 } });

    expect(automationConversationConfig.parseJson(raw)).toBeNull();
  });
});
