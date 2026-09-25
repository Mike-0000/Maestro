import type Anthropic from '@anthropic-ai/sdk';

/**
 * Translation between the conductor's native (Anthropic Messages) turn format and OpenRouter's
 * OpenAI-style chat completions. The renderer's tool loop stays provider-agnostic: main translates
 * the request out and the response back into content blocks (text + tool_use).
 */

export type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type OpenAiTool = {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

type Block = Anthropic.Beta.BetaContentBlockParam;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === 'text' ? (part.text ?? '') : ''
    )
    .join('');
}

export function toOpenAiMessages(
  system: string,
  messages: readonly Anthropic.Beta.BetaMessageParam[]
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content } as OpenAiMessage);
      continue;
    }
    const blocks = message.content as Block[];
    if (message.role === 'assistant') {
      // Thinking blocks are Anthropic-specific and signed; they are dropped for other providers.
      const text = blocks
        .filter((block): block is Anthropic.Beta.BetaTextBlockParam => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = blocks
        .filter((block): block is Anthropic.Beta.BetaToolUseBlockParam => block.type === 'tool_use')
        .map<OpenAiToolCall>((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // User turns carry text and/or tool results; tool results become role 'tool' messages.
    const texts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const body = textOf(block.content);
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `Error: ${body}` : body,
        });
      } else if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function toOpenAiTools(tools: readonly Anthropic.Beta.BetaTool[]): OpenAiTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema as Record<string, unknown>,
    },
  }));
}

export type OpenAiChoice = {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
    tool_calls?: OpenAiToolCall[] | null;
    refusal?: string | null;
  };
};

/** An OpenRouter choice as conductor content blocks and an Anthropic-style stop reason. */
export function fromOpenAiChoice(choice: OpenAiChoice): {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
} {
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const text = choice.message?.content?.trim();
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.Beta.BetaTextBlock);
  for (const call of choice.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      // Leave the input empty; the tool's schema validation reports the problem to the model.
      input = { _unparsed: call.function.arguments };
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input,
    } as Anthropic.Beta.BetaToolUseBlock);
  }
  const hasTools = content.some((block) => block.type === 'tool_use');
  const stopReason = choice.message?.refusal
    ? 'refusal'
    : hasTools
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';
  return { content, stopReason };
}

/** OpenRouter's reasoning effort accepts low/medium/high. */
export function openRouterEffort(effort: string): 'low' | 'medium' | 'high' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}
