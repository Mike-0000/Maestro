/**
 * Where new work (spawn_agent, propose_plan) goes. Jev's settled reading of the developer's words
 * wins; then the project the model named; then the only open project. With several open and none
 * named, nothing starts: the model asks the developer which one, in one short question, instead
 * of Maestro guessing from focus.
 */

export type ProjectRef = { readonly id: string; readonly name: string };

export type NewWorkProject =
  | { kind: 'settled'; project: ProjectRef; overrode: string | null }
  | { kind: 'named'; reference: string }
  | { kind: 'only'; project: ProjectRef }
  | { kind: 'ask'; text: string }
  | { kind: 'none' };

/** How many open projects the question offers by name. */
const ASK_NAMES = 4;

export function chooseNewWorkProject(args: {
  /** The project the model passed, if any. */
  named: string | undefined;
  /** Jev's settled project for this turn, if it is still open. */
  settled: ProjectRef | null;
  /** Open projects, the one on screen first when there is one. */
  open: readonly ProjectRef[];
  /** The tool that would start the work, for the question's wording. */
  tool: 'spawn_agent' | 'propose_plan';
}): NewWorkProject {
  const { named, settled, open, tool } = args;
  const reference = named?.trim() || undefined;
  if (settled && open.some((project) => project.id === settled.id)) {
    const differs = reference && reference.toLowerCase() !== settled.name.toLowerCase();
    return { kind: 'settled', project: settled, overrode: differs ? reference : null };
  }
  if (reference) return { kind: 'named', reference };
  if (open.length === 0) return { kind: 'none' };
  if (open.length === 1) return { kind: 'only', project: open[0] };
  return { kind: 'ask', text: askText(open, tool) };
}

function askText(open: readonly ProjectRef[], tool: 'spawn_agent' | 'propose_plan'): string {
  const names = open.slice(0, ASK_NAMES).map((project) => project.name);
  const offered = open.length > ASK_NAMES ? `${names.join(', ')}, or another` : orList(names);
  const what = tool === 'spawn_agent' ? 'the agent' : 'the plan';
  return [
    `Nothing started yet: the developer did not say which project ${what} is for, and ${open.length} projects are open.`,
    `Ask them in one short, natural question, such as "Which project, ${offered}?", and keep everything else you planned.`,
    `When they answer, call ${tool} again with project set to their answer. Do not say anything failed or could not be done; you are just checking where it goes.`,
  ].join(' ');
}

function orList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
