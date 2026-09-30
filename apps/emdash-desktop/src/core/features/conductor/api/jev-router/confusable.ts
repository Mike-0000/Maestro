import { editDistance, normalizeSpoken, phoneticKey, type RosterAgent } from '../resolver';

/**
 * Agent names a transcript can confuse: "Maple" and "Maple 2", "Delta" and "Delta 2", or names one
 * edit or one sound apart. Jev gets rubrics that spell out the difference, and a split between two
 * of them is treated as a question for the developer, never a guess.
 */

function base(name: string): string {
  return normalizeSpoken(name)
    .replace(/\s*\d+$/, '')
    .trim();
}

export function areConfusable(a: string, b: string): boolean {
  if (a === b) return false;
  const baseA = base(a);
  const baseB = base(b);
  if (baseA && baseA === baseB) return true;
  const spokenA = normalizeSpoken(a);
  const spokenB = normalizeSpoken(b);
  if (Math.min(spokenA.length, spokenB.length) >= 4 && editDistance(spokenA, spokenB) <= 1) {
    return true;
  }
  return baseA.length >= 3 && phoneticKey(baseA) === phoneticKey(baseB);
}

/** For each agent name, the other roster names it can be confused with. */
export function confusableNames(roster: readonly RosterAgent[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const agent of roster) {
    const others = roster
      .filter((other) => areConfusable(agent.name, other.name))
      .map((other) => other.name);
    if (others.length > 0) result.set(agent.name, others);
  }
  return result;
}

/**
 * Two confusable options sharing the top of a distribution: the leader's lead is under `gap` and
 * together they hold most of the mass. Returns the pair (leader first) or null.
 */
export function confusableSplit(
  probabilities: Readonly<Record<string, number>>,
  confusable: ReadonlyMap<string, readonly string[]>,
  gap = 0.3
): [string, string] | null {
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || !second) return null;
  if (!confusable.get(first[0])?.includes(second[0])) return null;
  if (first[1] - second[1] >= gap || first[1] + second[1] < 0.6) return null;
  return [first[0], second[0]];
}
