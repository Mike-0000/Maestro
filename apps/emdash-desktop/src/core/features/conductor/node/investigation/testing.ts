import type { ExecOptions } from '@emdash/core/services/exec/api';
import type { ScoutExecFactory } from './scout-runner';

/**
 * Test support for the code scout: event streams captured from Claude Code 2.1.296 with the
 * scout's own arguments, and a stand-in for the process.
 *
 * The events are real ones, trimmed: ids, token counts and signatures are dropped, long lists
 * are shortened, and the temporary folder is renamed `C:\work`. Field names and values are as
 * the CLI printed them, including the fields a scout ignores.
 */

export const CAPTURED_VERSION = '2.1.296';

/** The first event of every run. */
export const INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  cwd: 'C:\\work\\project',
  tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'],
  mcp_servers: [],
  model: 'claude-haiku-5-5',
  permissionMode: 'default',
  slash_commands: ['deep-research', 'design'],
  claude_code_version: CAPTURED_VERSION,
  agents: ['claude', 'Explore'],
  skills: ['deep-research', 'design'],
  plugins: [
    { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
  ],
};

function toolUse(name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: {
      model: 'claude-haiku-5-5',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
      stop_reason: null,
    },
  };
}

const ANSWER = {
  answer:
    'Yes. The project has a retry helper, `retry`, defined in `src\\retry.ts`. It is exported as `retry<T>(work: () => Promise<T>, attempts = 3): Promise<T>`. It calls `work()` and, on rejection, recurses with `attempts - 1` until attempts run out, then rethrows the last error. It retries immediately with no delay or backoff.',
  found: 'yes',
  evidence: [
    {
      path: 'src\\retry.ts',
      line: 1,
      quote: 'export function retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {',
    },
    { path: 'src\\retry.ts', line: 4, quote: 'return retry(work, attempts - 1);' },
  ],
};

/** "Is there a retry helper in this project, and which file defines it?" */
export const ANSWERED_EVENTS: readonly unknown[] = [
  INIT_EVENT,
  toolUse('Grep', {
    pattern: '(?i)\\b(retry|retries|withRetry|retryWith|backoff)\\b',
    path: 'C:\\work\\project',
    output_mode: 'files_with_matches',
  }),
  toolUse('Glob', { pattern: '**/*retry*', path: 'C:\\work\\project' }),
  { type: 'rate_limit_event' },
  toolUse('Read', { file_path: 'C:\\work\\project\\src\\retry.ts' }),
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 },
  {
    type: 'assistant',
    message: {
      model: 'claude-haiku-5-5',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Yes. The helper is `retry` in `src\\retry.ts`, line 1.' }],
      stop_reason: null,
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.',
        },
      ],
    },
  },
  toolUse('StructuredOutput', ANSWER),
  {
    stop_reason: 'tool_use',
    total_cost_usd: 0.0019863300000000006,
    permission_denials: [],
    terminal_reason: 'completed',
    is_error: false,
    num_turns: 6,
    subtype: 'success',
    result: JSON.stringify(ANSWER),
    structured_output: ANSWER,
    type: 'result',
    duration_ms: 5685,
  },
];

/**
 * A run with a signed-out configuration. Its permission mode was pinned for the capture: with a
 * fresh configuration folder this CLI version reports `auto` (see `FRESH_CONFIG_INIT_EVENT`).
 * The process exits with code 1 after the result event.
 */
export const NOT_SIGNED_IN_EVENTS: readonly unknown[] = [
  INIT_EVENT,
  {
    type: 'assistant',
    message: {
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      type: 'message',
      content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
    },
    error: 'authentication_failed',
    is_api_error_message: true,
  },
  {
    stop_reason: 'stop_sequence',
    total_cost_usd: 0,
    permission_denials: [],
    terminal_reason: 'api_error',
    is_error: true,
    num_turns: 1,
    subtype: 'success',
    result: 'Not logged in · Please run /login',
    type: 'result',
    duration_ms: 153,
  },
];

/** What the same CLI reports first when its configuration folder is new: not the default mode. */
export const FRESH_CONFIG_INIT_EVENT = { ...INIT_EVENT, permissionMode: 'auto' };

const DENIED_ANSWER = {
  answer:
    'I could not read either file. The Read tool refused .env because its directory is denied by permission settings, and refused outside.txt because it is outside the working directory under --restricted.',
  found: 'no',
  evidence: [
    {
      path: 'C:\\work\\project\\.env',
      quote: 'File is in a directory that is denied by your permission settings.',
    },
    {
      path: 'C:\\work\\outside.txt',
      quote:
        'outside C:\\work\\project; --restricted confines the file tools to the working directory.',
    },
  ],
};

/** A scout asked to read `.env` and a file outside the project. Both reads were refused. */
export const DENIED_EVENTS: readonly unknown[] = [
  INIT_EVENT,
  toolUse('Read', { file_path: 'C:\\work\\project\\.env' }),
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content:
            '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>',
          is_error: true,
        },
      ],
    },
  },
  toolUse('Read', { file_path: 'C:\\work\\outside.txt' }),
  {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Read',
    decision_reason_type: 'other',
    decision_reason: '--restricted: path outside the working directory',
    message:
      'C:\\work\\outside.txt is outside C:\\work\\project; --restricted confines the file tools to the working directory.',
  },
  toolUse('StructuredOutput', DENIED_ANSWER),
  {
    stop_reason: 'tool_use',
    total_cost_usd: 0.00089336,
    permission_denials: [
      { tool_name: 'Read', tool_input: { file_path: 'C:\\work\\project\\.env' } },
      { tool_name: 'Read', tool_input: { file_path: 'C:\\work\\outside.txt' } },
    ],
    terminal_reason: 'completed',
    is_error: false,
    num_turns: 5,
    subtype: 'success',
    result: JSON.stringify(DENIED_ANSWER),
    structured_output: DENIED_ANSWER,
    type: 'result',
    duration_ms: 4232,
  },
];

/** The answered run cut off before its result, as when the process dies mid-answer. */
export const NO_RESULT_EVENTS: readonly unknown[] = ANSWERED_EVENTS.slice(0, -1);

/** The answered run with a tool call ahead of the start event. Built: the CLI never did this. */
export const EARLY_EVENT_EVENTS: readonly unknown[] = [
  ANSWERED_EVENTS[1],
  ...ANSWERED_EVENTS.filter((_, index) => index !== 1),
];

/** Events as the CLI prints them: one JSON object per line. */
export function scoutStream(events: readonly unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

export type FakeScoutCall = {
  file: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  options: ExecOptions;
};

/** The start event's folder as it appears in `scoutStream` output. */
const CAPTURED_CWD = `"cwd":${JSON.stringify(INIT_EVENT.cwd)}`;

/**
 * A stand-in for the process. `behave` plays the child: it writes to `emit` (false means the
 * runner asked for the process to be killed) and settles the way the exec helper would. Like a
 * real CLI, it reports the folder it was started in: the captured start event's folder becomes
 * the call's. A start event with any other folder is passed through as written.
 */
export function fakeScoutExec(
  behave: (call: FakeScoutCall, emit: (chunk: string) => boolean) => Promise<void>
): { exec: ScoutExecFactory; calls: FakeScoutCall[] } {
  const calls: FakeScoutCall[] = [];
  return {
    calls,
    exec: ({ file, cwd, env }) => ({
      execStreaming: (args, onStdout, options = {}) => {
        const call = { file, cwd, env, args, options };
        calls.push(call);
        const cwdField = `"cwd":${JSON.stringify(cwd)}`;
        return behave(
          call,
          (chunk) => onStdout(chunk.replaceAll(CAPTURED_CWD, cwdField)) !== false
        );
      },
    }),
  };
}
