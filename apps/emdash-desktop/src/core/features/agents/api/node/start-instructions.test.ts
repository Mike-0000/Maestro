import { describe, expect, it } from 'vitest';
import { ATTENTION_SYSTEM_PROMPT } from '@core/features/conductor/api/attention-verdict';
import { CHAT_CONDUCTOR_SYSTEM_PROMPT } from '@core/features/conductor/api/chat-conductor/prompt';
import { CONDUCTOR_SYSTEM_PROMPT } from '@core/features/conductor/api/system-prompt';
import { getPlugin } from './plugin-registry';

const BRANCH_SYNC = /new conversation.*fast-forwarding it/;

describe('branch sync start instruction', () => {
  it('reaches a new Claude chat', () => {
    const claude = getPlugin('claude');
    const { args } = claude.behavior.prompt!.buildCommand({
      cli: 'claude',
      autoApprove: false,
      sessionId: '6f1c2f0e-7d1b-4c43-9a55-2d4b0e1f3a10',
      providerSessionId: undefined,
      model: '',
      isResuming: false,
      initialPrompt: 'hello',
    });
    expect(args.join(' ')).toMatch(BRANCH_SYNC);
    expect(JSON.stringify(claude.behavior.acp!.sessionMeta!())).toMatch(BRANCH_SYNC);
  });

  it("stays out of the conductor's own prompts", () => {
    const prompts = [
      CONDUCTOR_SYSTEM_PROMPT,
      CHAT_CONDUCTOR_SYSTEM_PROMPT,
      ATTENTION_SYSTEM_PROMPT,
    ];
    for (const prompt of prompts) expect(String(prompt)).not.toMatch(BRANCH_SYNC);
  });
});
