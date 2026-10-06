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
  'would be costly to hand over. Sub-agents cost extra time and tokens, so use them only where ' +
  'they shorten the work or improve the result. If the developer says to use sub-agents, or says ' +
  'not to, follow that instead.';

const SYSTEM_PROMPT_FLAG = /^--(append-)?system-prompt(-file)?(=|$)/;

/**
 * Puts the delegation policy ahead of the user's extra args. A user who sets their own system
 * prompt in "Additional parameters" keeps it untouched.
 */
export function withDelegationPolicy(extraArgs: string[] = []): string[] {
  if (extraArgs.some((arg) => SYSTEM_PROMPT_FLAG.test(arg))) return extraArgs;
  return ['--append-system-prompt', CLAUDE_DELEGATION_POLICY, ...extraArgs];
}
