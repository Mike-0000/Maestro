import { defineContract, eventStream, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const markdownViewerDomain = 'markdownViewer' as const;

/**
 * A Markdown file the viewer may show: the workspace it was checked against and its canonical
 * path. A window keeps this and has it checked again whenever it reads the file.
 */
export const markdownDocSchema = z.object({
  projectId: z.string().min(1),
  /** The workspace the file belongs to: the agent's working directory. */
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  /** Absolute path with symlinks resolved. */
  path: z.string().min(1),
  title: z.string().min(1),
});
export type MarkdownDoc = z.infer<typeof markdownDocSchema>;

export const markdownAccessErrorSchema = z.object({
  code: z.enum([
    'invalid-path',
    'not-markdown',
    'not-image',
    'outside-roots',
    'not-found',
    'not-a-file',
    'too-large',
    'unknown-workspace',
    'remote-workspace',
    'unreadable',
  ]),
  /** A full sentence: shown in the viewer and returned to the agent. */
  message: z.string(),
});
export type MarkdownAccessError = z.infer<typeof markdownAccessErrorSchema>;

/** Names the workspace whose folders bound what may be read. */
const workspaceRefSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
});

/** An agent's `show_markdown` call, on its way to the window. */
export const markdownShowRequestSchema = z.object({
  id: z.string(),
  at: z.string(),
  /** The conversation whose agent asked; the window opens beside it. */
  conversationId: z.string(),
  doc: markdownDocSchema,
  /** Open the viewer now. False: offer the file and let the developer open it. */
  present: z.boolean(),
});
export type MarkdownShowRequest = z.infer<typeof markdownShowRequestSchema>;

export const markdownShowAckSchema = z.object({
  outcome: z.enum(['opened', 'offered', 'failed']),
  /** Returned to the agent as the tool result. */
  message: z.string(),
});
export type MarkdownShowAck = z.infer<typeof markdownShowAckSchema>;

export const markdownViewerContract = defineContract({
  /**
   * Checks a path a link, a saved window or an agent names. A relative path is read against the
   * workspace folder, or against `from`'s folder when a document references it.
   */
  resolve: fallible({
    input: workspaceRefSchema.extend({ path: z.string(), from: z.string().optional() }),
    data: z.object({ path: z.string(), name: z.string() }),
    error: markdownAccessErrorSchema,
  }),
  /** Reads a document after checking it again. */
  read: fallible({
    input: workspaceRefSchema.extend({ path: z.string() }),
    data: z.object({ path: z.string(), name: z.string(), content: z.string() }),
    error: markdownAccessErrorSchema,
  }),
  /** An image a document references, as a data URL. */
  readImage: fallible({
    input: workspaceRefSchema.extend({ from: z.string(), src: z.string() }),
    data: z.object({ dataUrl: z.string() }),
    error: markdownAccessErrorSchema,
  }),
  /** Files agents ask the window to show, through their session's MCP tool. */
  showRequests: eventStream({ key: z.void(), event: markdownShowRequestSchema }),
  /** What the window did with a request; the agent's tool call is waiting for it. */
  acknowledgeShowRequest: procedure({
    input: z.object({ id: z.string(), ack: markdownShowAckSchema }),
    /** False when the tool call stopped waiting: the agent was told nothing happened. */
    output: z.object({ delivered: z.boolean() }),
  }),
});

export type MarkdownViewerContract = typeof markdownViewerContract;
