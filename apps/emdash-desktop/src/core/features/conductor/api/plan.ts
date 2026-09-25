import type { ConductorToolInput } from './tools';

export type PlanInput = ConductorToolInput<'propose_plan'>;
export type PlanSubtask = PlanInput['subtasks'][number];

export type PlanOverlap = { a: string; b: string; pathA: string; pathB: string };

/** The literal directory prefix of a glob ("src/auth/**" -> ["src","auth"]). */
export function staticPrefix(glob: string): string[] {
  const segments = glob
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter((segment) => segment && segment !== '.');
  const prefix: string[] = [];
  for (const segment of segments) {
    if (/[*?[\]{}]/.test(segment)) break;
    prefix.push(segment.toLowerCase());
  }
  return prefix;
}

/**
 * Conservative overlap test: two globs may touch the same file when one literal prefix contains
 * the other. An empty prefix (e.g. "**") overlaps everything.
 */
export function pathsMayOverlap(a: string, b: string): boolean {
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  const shorter = prefixA.length <= prefixB.length ? prefixA : prefixB;
  const longer = shorter === prefixA ? prefixB : prefixA;
  return shorter.every((segment, index) => longer[index] === segment);
}

function isOrdered(plan: readonly PlanSubtask[], a: PlanSubtask, b: PlanSubtask): boolean {
  const byTitle = new Map(plan.map((subtask) => [subtask.title, subtask]));
  const dependsOn = (from: PlanSubtask, target: PlanSubtask): boolean => {
    const seen = new Set<string>();
    let current: PlanSubtask | undefined = from;
    while (current?.sequential_after && !seen.has(current.title)) {
      seen.add(current.title);
      if (current.sequential_after === target.title) return true;
      current = byTitle.get(current.sequential_after);
    }
    return false;
  };
  return dependsOn(a, b) || dependsOn(b, a);
}

/** Pairs of parallel subtasks whose owned paths may collide (the plan should be revised). */
export function findPlanOverlaps(subtasks: readonly PlanSubtask[]): PlanOverlap[] {
  const overlaps: PlanOverlap[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b || isOrdered(subtasks, a, b)) continue;
      for (const pathA of a.owned_paths) {
        const pathB = b.owned_paths.find((candidate) => pathsMayOverlap(pathA, candidate));
        if (pathB) {
          overlaps.push({ a: a.title, b: b.title, pathA, pathB });
          break;
        }
      }
    }
  }
  return overlaps;
}

/** The instruction appended to every planned agent's prompt so it stays in its lane. */
export function scopedPrompt(subtask: PlanSubtask, goal: string): string {
  const lines = [
    subtask.prompt.trim(),
    '',
    `This is one part of a larger goal being worked on in parallel: ${goal.trim()}`,
    `You own these paths: ${subtask.owned_paths.join(', ')}. Do not edit files outside them; if you must, say so in your final message.`,
  ];
  if (subtask.acceptance?.trim()) {
    lines.push(`When you are done, run \`${subtask.acceptance.trim()}\` and make sure it passes.`);
  }
  return lines.join('\n');
}
