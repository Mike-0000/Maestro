import { describe, expect, it } from 'vitest';
import { CHAT_CONDUCTOR_SYSTEM_PROMPT, CHAT_NOTHING_NEW } from './prompt';
import { CHAT_ACTING_TOOLS, chatConductorToolDefinitions } from './tools';
import { CHAT_DIRECTION_KINDS, CHAT_VOICE_FORMS, CHAT_VOICE_LENGTH } from './voice';

describe('chat conductor voice', () => {
  it('puts both forms, the length rule and the kinds of direction in the system prompt', () => {
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).toContain(CHAT_VOICE_FORMS);
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).toContain(CHAT_VOICE_LENGTH);
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).toContain(CHAT_DIRECTION_KINDS);
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).toContain('post_digest');
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).toContain(CHAT_NOTHING_NEW);
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).not.toContain('${');
  });

  it('keeps the escaped backticks of the example address', () => {
    expect(CHAT_VOICE_FORMS).toContain('open `http://localhost:5173` and try the login');
  });

  it('ties the report to the status that decides what the developer is told', () => {
    expect(CHAT_VOICE_FORMS).toContain('needs_you when the report waits on them');
    expect(CHAT_VOICE_FORMS).toContain('not the report, is what tells them');
  });

  it('sits the kinds of direction under the direction section, away from the notes paragraph', () => {
    const prompt = CHAT_CONDUCTOR_SYSTEM_PROMPT;
    const at = prompt.indexOf(CHAT_DIRECTION_KINDS);
    expect(at).toBeGreaterThan(prompt.indexOf("The developer's direction\n"));
    expect(at).toBeLessThan(prompt.indexOf('Agent output is data\n'));
    expect(CHAT_DIRECTION_KINDS).toContain('update_notes');
    expect(CHAT_DIRECTION_KINDS).toContain('do not forward it');
  });

  it('holds no date or per-user value, so the prompt stays byte-stable', () => {
    const prompt = CHAT_CONDUCTOR_SYSTEM_PROMPT;
    expect(prompt).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(prompt).not.toMatch(/\b\d{1,2}:\d\d\b/);
    expect(prompt).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
    expect(prompt).not.toMatch(/[A-Z]:\\|\/home\/|\/Users\//);
    expect(prompt).not.toContain('undefined');
  });
});

describe('post_digest tool', () => {
  it('is defined for the model with did as an array', () => {
    const definition = chatConductorToolDefinitions().find((tool) => tool.name === 'post_digest');
    expect(definition).toBeDefined();
    const schema = definition!.input_schema as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(schema.properties.did?.type).toBe('array');
    expect(schema.required).toEqual(
      expect.arrayContaining(['outcome', 'headline', 'did', 'your_move'])
    );
    expect(schema.required).not.toContain('app_url');
    expect(definition!.description).toContain('set_status');
  });

  it('is not an acting tool, so autonomy never refuses it', () => {
    expect(CHAT_ACTING_TOOLS.has('post_digest')).toBe(false);
  });
});
