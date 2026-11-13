import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { redactAll } from '@emdash/shared/logger';
import { z } from 'zod';
import { isChatEventTurnStart } from '../api/chat-conductor/turns';

/**
 * The log of what chat and task conductors were given and what they did: one line for every model
 * call, with the input that call added (the developer's words or the chat event, or the results of
 * the tools the call before it asked for), the tools it called with their inputs, and what it
 * said. A conductor's saved thread keeps only a trimmed window of this, so a review of how it
 * acted needs the log. Local only, redacted, bounded by size and age, and kept under the same
 * opt-in as the other conductor diagnostics.
 */
const FILE = 'chat-conductor-log.jsonl';
const MAX_BYTES = 4 * 1024 * 1024;
/** A turn's start: the context block and the developer's words, or the event with agent output. */
const INPUT_CHARS = 16_000;
/** Room for a whole prompt sent to an agent. */
const TOOL_INPUT_CHARS = 16_000;
const TOOL_RESULT_CHARS = 4_000;
const REPLY_CHARS = 8_000;
const MAX_TOOLS = 20;

export const chatTurnLogRecordSchema = z.object({
  at: z.string(),
  /** The task whose conductor made the call, when the caller named it. */
  taskId: z.string().optional(),
  /** What the call's newest input was: a developer message, a chat event, or tool results. */
  trigger: z.enum(['developer', 'event', 'tool-results']),
  /** The text that started the turn; empty on a call that only carries tool results. */
  input: z.string(),
  toolResults: z.array(
    z.object({ toolUseId: z.string(), content: z.string(), isError: z.boolean() })
  ),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.string() })),
  reply: z.string(),
  stopReason: z.string().nullable(),
  model: z.string().optional(),
  /** Input and output tokens; input written to the prompt cache counts as input. */
  tokens: z.number().optional(),
  /** Input tokens read from the prompt cache, not counted in `tokens`. */
  cacheReadTokens: z.number().optional(),
  latencyMs: z.number(),
  /** Set when the call failed: its kind and message. */
  error: z.object({ type: z.string(), message: z.string() }).optional(),
});
export type ChatTurnLogRecord = z.infer<typeof chatTurnLogRecordSchema>;

type Message = Anthropic.Beta.BetaMessageParam;

type CallOutcome =
  | {
      success: true;
      data: {
        content: readonly Anthropic.Beta.BetaContentBlock[];
        stopReason: string | null;
        model: string;
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
      };
    }
  | { success: false; error: { type: string; message: string } };

function resultText(content: Anthropic.Beta.BetaToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
}

/** What one model call added to the record: its newest input and what the model answered. */
export function chatTurnLogRecord(input: {
  at: string;
  taskId?: string;
  messages: readonly Message[];
  outcome: CallOutcome;
  latencyMs: number;
}): ChatTurnLogRecord {
  const last = input.messages[input.messages.length - 1];
  const text = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
  const blocks = last?.role === 'user' && typeof last.content !== 'string' ? last.content : [];
  const toolResults = blocks.flatMap((block) =>
    block.type === 'tool_result'
      ? [
          {
            toolUseId: block.tool_use_id,
            content: resultText(block.content).slice(0, TOOL_RESULT_CHARS),
            isError: block.is_error === true,
          },
        ]
      : []
  );
  const content = input.outcome.success ? input.outcome.data.content : [];
  return {
    at: input.at,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    trigger:
      last && typeof last.content === 'string'
        ? isChatEventTurnStart(last)
          ? 'event'
          : 'developer'
        : 'tool-results',
    input: text.slice(0, INPUT_CHARS),
    toolResults: toolResults.slice(0, MAX_TOOLS),
    toolCalls: content
      .flatMap((block) =>
        block.type === 'tool_use'
          ? [
              {
                id: block.id,
                name: block.name,
                input: (JSON.stringify(block.input) ?? '').slice(0, TOOL_INPUT_CHARS),
              },
            ]
          : []
      )
      .slice(0, MAX_TOOLS),
    reply: content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .slice(0, REPLY_CHARS),
    stopReason: input.outcome.success ? input.outcome.data.stopReason : null,
    ...(input.outcome.success
      ? {
          model: input.outcome.data.model,
          tokens: input.outcome.data.usage.inputTokens + input.outcome.data.usage.outputTokens,
          ...(input.outcome.data.usage.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: input.outcome.data.usage.cacheReadTokens }),
        }
      : { error: input.outcome.error }),
    latencyMs: input.latencyMs,
  };
}

/** The file behind the log. All disk operations run one after another, deletion included. */
export class ChatTurnLog {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work, work);
    this.pending = next.catch(() => {});
    return next;
  }

  append(record: ChatTurnLogRecord, days: number): Promise<void> {
    return this.enqueue(async () => {
      const records = await this.load(days);
      // Redacted before it reaches the disk: a key in agent output or a prompt is never stored.
      records.push(chatTurnLogRecordSchema.parse(JSON.parse(redactAll(JSON.stringify(record)))));
      await this.save(records);
    });
  }

  /** The newest `limit` records, oldest first. Also drops what is past its age. */
  read(limit: number, days: number): Promise<ChatTurnLogRecord[]> {
    return this.enqueue(async () => {
      const records = await this.load(days);
      await this.save(records);
      return records.slice(-limit);
    });
  }

  delete(): Promise<void> {
    return this.enqueue(async () => {
      await rm(join(this.dir, FILE), { force: true });
      await rm(join(this.dir, FILE + '.tmp'), { force: true });
    });
  }

  private async load(days: number): Promise<ChatTurnLogRecord[]> {
    const path = join(this.dir, FILE);
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size > MAX_BYTES * 2) return [];
    const raw = await readFile(path, 'utf8').catch(() => '');
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return raw.split('\n').flatMap((line) => {
      try {
        const parsed = chatTurnLogRecordSchema.safeParse(JSON.parse(line));
        return parsed.success && parsed.data.at >= cutoff ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  private async save(records: ChatTurnLogRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lines = records.map((record) => JSON.stringify(record) + '\n');
    let bytes = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const size = Buffer.byteLength(line);
      if (bytes + size > MAX_BYTES) break;
      kept.unshift(line);
      bytes += size;
    }
    const path = join(this.dir, FILE);
    await writeFile(path + '.tmp', kept.join(''), { encoding: 'utf8', mode: 0o600 });
    await rename(path + '.tmp', path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  }
}
