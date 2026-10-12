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

export type OpenAiUserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** A text part that marks the end of a prompt prefix the provider may cache. */
export type OpenAiCachedTextPart = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
};

export type OpenAiMessage =
  | {
      role: 'system';
      content: string | (OpenAiCachedTextPart | { type: 'text'; text: string })[];
    }
  | { role: 'user'; content: string | OpenAiUserPart[] }
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

/** Base64 images inside a tool result, as data URLs. */
function imagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: { type?: string; source?: Anthropic.Beta.BetaBase64ImageSource }) =>
    part.type === 'image' && part.source?.type === 'base64'
      ? [`data:${part.source.media_type};base64,${part.source.data}`]
      : []
  );
}

/**
 * Anthropic models cache a prompt prefix through OpenRouter only when a breakpoint marks its end.
 * Tools render before the system prompt, so one breakpoint on the system prompt covers both.
 */
export function cachesByBreakpoint(model: string): boolean {
  return model.startsWith('anthropic/');
}

export function toOpenAiMessages(
  system: string,
  messages: readonly Anthropic.Beta.BetaMessageParam[],
  options: {
    cacheSystem?: boolean;
    /** Text that follows the system prompt and may change between turns; '' adds nothing. */
    standing?: string;
  } = {}
): OpenAiMessage[] {
  const standing = options.standing ?? '';
  const out: OpenAiMessage[] = [
    options.cacheSystem
      ? {
          role: 'system',
          // The breakpoint stays on the fixed prompt, so what follows it never costs its cache.
          content: [
            { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
            ...(standing ? [{ type: 'text' as const, text: standing }] : []),
          ],
        }
      : { role: 'system', content: standing ? `${system}\n\n${standing}` : system },
  ];
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
    // OpenAI-style tool messages are text-only, so screenshots follow as one user message.
    const texts: string[] = [];
    const images: string[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const body = textOf(block.content);
        images.push(...imagesOf(block.content));
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `Error: ${body}` : body,
        });
      } else if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    if (images.length > 0) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshots returned by the tool calls above:' },
          ...images.map<OpenAiUserPart>((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
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
