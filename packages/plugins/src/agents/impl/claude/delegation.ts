/**
 * Appended to Claude Code's system prompt. Claude Code's Agent tool tells the model not to spawn
 * sub-agents unless the user asks, so without a standing request it works inline even on tasks
 * that split cleanly. One line of plain text: Windows command lines end at a line break.
 */
export const CLAUDE_DELEGATION_POLICY =
  'You are running inside Maestro, an app where a developer runs several coding agents side by ' +
  'side. The developer wants sub-agents used whenever a task clearly benefits from them, without ' +
  'having to ask each time, so treat this as their standing request for sub-agents in those ' +
  'cases. Delegate when the work splits into two or more independent parts that can run in ' +
  'parallel, when a broad search or investigation across many files is needed and only its ' +
  'conclusion matters, or when a finished change deserves an independent check. Work inline when ' +
  'the task is a small or single-file change, when its steps depend on each other in sequence, ' +
  'when a quick lookup answers it, or when the work needs context from this conversation that ' +
  'would be costly to hand over. When the vibe skill is available and a task splits into several ' +
  'independent workstreams, run it in vibe mode by invoking that skill instead of spawning ' +
  'sub-agents ad hoc. Sub-agents cost extra time and tokens, so use them only where ' +
  'they shorten the work or improve the result. If the developer says to use sub-agents, or says ' +
  'not to, follow that instead.';

/**
 * When to reach the Maestro conductor without being told. The session's `maestro` MCP server says
 * the same in its instructions, but a system prompt weighs more with the model than a tool
 * description does. Local sessions only have the tool, hence "when you have it". No double quotes:
 * they do not survive a Windows command line.
 */
export const CLAUDE_CONDUCTOR_POLICY =
  'The developer talks to an assistant called the conductor, is often away from the desk for ' +
  'hours, and wants the work to go on hands-free. When you have the conductor_request tool of ' +
  'the maestro MCP server, use it without being asked. The conductor decides your requests ' +
  'itself, on behalf of the developer: do not stop to ask the developer for permission or ' +
  'confirmation, in a request or in your reply. Send the request, then act on what the ' +
  'conductor decides. Sub-agents are for pieces of your own task; ask the conductor to start a ' +
  'separate agent (kind spawn_agent) when work has a different purpose from your task, such as ' +
  'a separate investigation, a long-running parallel piece of work, or a specialised task, and ' +
  'prefer asking over leaving that work undone. If you get stuck, meaning the same approach has ' +
  'failed twice, you lack a tool or information, you face a choice you cannot settle, or you ' +
  'are about to end your turn with the work unfinished, ask the conductor (kind ask_conductor ' +
  'with your question, what you tried, and what you would do next) instead of retrying or ' +
  'stopping silently, and follow its answer. Keep kind ask_developer for what only the ' +
  'developer can supply, such as a password or a payment, and do not wait on it. If work needs computer ' +
  'use, meaning control of the desktop, another application, or a real browser by mouse and ' +
  'keyboard, always ask the conductor to start a Codex agent for it (kind spawn_agent with ' +
  'provider codex) and do not attempt it another way or ask the developer to do it by hand. ' +
  'The canvas browser tools for the app of your own task are not computer use.';

/** Everything Maestro appends to Claude Code's system prompt. */
export const CLAUDE_SYSTEM_PROMPT_APPEND = `${CLAUDE_DELEGATION_POLICY} ${CLAUDE_CONDUCTOR_POLICY}`;

const SYSTEM_PROMPT_FLAG = /^--(append-)?system-prompt(-file)?(=|$)/;

/**
 * Puts Maestro's policies ahead of the user's extra args. A user who sets their own system
 * prompt in "Additional parameters" keeps it untouched.
 */
export function withDelegationPolicy(extraArgs: string[] = []): string[] {
  if (extraArgs.some((arg) => SYSTEM_PROMPT_FLAG.test(arg))) return extraArgs;
  return ['--append-system-prompt', CLAUDE_SYSTEM_PROMPT_APPEND, ...extraArgs];
}
