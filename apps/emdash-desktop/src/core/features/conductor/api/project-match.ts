/**
 * Which open project a spoken or written project reference means. A reference that matches no
 * project, or several equally well, is an answer to give back, never a project to guess: a guess
 * once put an agent meant for "Maestro" into "Wearable Maestro Trigger" without a word.
 */

export type NamedProject = { readonly id: string; readonly name: string };

export type ProjectMatch =
  | { readonly kind: 'match'; readonly id: string }
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] }
  | { readonly kind: 'none' };

/** Lower case, punctuation as spaces, and "the … project" dropped: "the Maestro (WSL) project". */
export function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/\s+(?:project|repo|repository)$/, '')
    .trim();
}

function words(name: string): string[] {
  return name ? name.split(' ') : [];
}

export function matchProject(reference: string, projects: readonly NamedProject[]): ProjectMatch {
  const wanted = normalizeProjectName(reference);
  if (!wanted) return { kind: 'none' };
  const named = projects.map((project) => ({
    project,
    normalized: normalizeProjectName(project.name),
  }));
  const pick = (found: readonly (typeof named)[number][]): ProjectMatch | null => {
    if (found.length === 1 && found[0]) return { kind: 'match', id: found[0].project.id };
    if (found.length > 1) return { kind: 'ambiguous', names: found.map((f) => f.project.name) };
    return null;
  };
  const exact = pick(named.filter((entry) => entry.normalized === wanted));
  if (exact) return exact;
  // Every spoken word appears in the name, as whole words: "maestro wsl" for "Maestro (WSL)".
  const wantedWords = words(wanted);
  const containing = named.filter((entry) => {
    const have = new Set(words(entry.normalized));
    return wantedWords.every((word) => have.has(word));
  });
  return pick(containing) ?? { kind: 'none' };
}

/** What the conductor tells the model when a project reference cannot be used. */
export function projectMatchError(
  reference: string,
  match: Exclude<ProjectMatch, { kind: 'match' }>,
  projects: readonly NamedProject[]
): string {
  if (match.kind === 'ambiguous') {
    return `"${reference}" could mean ${match.names.map((name) => `"${name}"`).join(' or ')}. Ask the developer which project they mean, or use its exact name.`;
  }
  const open = projects.map((project) => `"${project.name}"`).join(', ');
  return `No open project is called "${reference}". Open projects: ${open || 'none'}. Ask the developer which one they mean.`;
}
