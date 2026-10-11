/**
 * The MCP tool an agent calls to show a Markdown file to the developer. The tool lives on the
 * session's `maestro` server, so the caller is the conversation its token was issued for: nothing
 * in the arguments can name another agent, task or project.
 */

export const SHOW_MARKDOWN_TOOL_NAME = 'show_markdown';

const PATH_CHARS = 4096;
const TITLE_CHARS = 80;

export type ShowMarkdownArguments = {
  readonly path: string;
  /** Open the viewer in front of the developer now, instead of only offering a link. */
  readonly present: boolean;
  readonly title?: string;
};

export type ParsedShowMarkdownArguments =
  | { readonly ok: true; readonly value: ShowMarkdownArguments }
  | { readonly ok: false; readonly error: string };

export function parseShowMarkdownArguments(
  args: Record<string, unknown>
): ParsedShowMarkdownArguments {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) {
    return { ok: false, error: 'Pass path: the Markdown file to show, absolute or relative.' };
  }
  if (path.length > PATH_CHARS || path.includes('\0')) {
    return { ok: false, error: 'path is not a usable file path.' };
  }
  if (args.present !== undefined && typeof args.present !== 'boolean') {
    return { ok: false, error: 'present must be true or false.' };
  }
  const title =
    typeof args.title === 'string' && args.title.trim()
      ? args.title.trim().slice(0, TITLE_CHARS)
      : undefined;
  return { ok: true, value: { path, present: args.present === true, ...(title ? { title } : {}) } };
}

export function showMarkdownToolDefinition(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: SHOW_MARKDOWN_TOOL_NAME,
    description: [
      "Show a Markdown file to the developer in Maestro's Markdown viewer, which renders it read-only and reloads it when the file changes on disk. Use it for a Markdown file you wrote or updated that the developer should read, such as a plan, a report or notes.",
      'By default the file is only offered: the developer gets a link and opens it when they choose. Pass present: true to open the viewer in front of the developer right away, in a window beside your work that fits the view they are in. Do that only when the developer asked you to show or present the file.',
      'Only .md, .markdown and .mdx files inside your working directory or the project folder can be shown. The result says whether the file was opened, offered or refused.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The Markdown file: an absolute path, or one relative to your working directory.',
        },
        present: {
          type: 'boolean',
          description:
            'true opens the viewer now without the developer clicking. Leave it out unless the developer asked to see the file.',
        },
        title: {
          type: 'string',
          description: 'A short name for the window. Defaults to the file name.',
        },
      },
      required: ['path'],
    },
  };
}

/** Added to the MCP server's instructions, which an agent reads once per session. */
export const SHOW_MARKDOWN_INSTRUCTIONS =
  'show_markdown shows a Markdown file from your workspace to the developer in a read-only viewer inside Maestro. It only offers the file unless you pass present: true, which opens it in front of the developer; use that when they asked to see it.';
