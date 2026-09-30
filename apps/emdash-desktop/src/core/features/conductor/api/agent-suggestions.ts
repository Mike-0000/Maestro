/** An agent provider the typed command box can offer to open. */
export type SuggestableProvider = { id: string; name: string; label: string };

export type AgentSuggestion = { providerId: string; label: string };

/** Abbreviations people type that neither the name nor its initials produce. */
const PROVIDER_ALIASES: Record<string, readonly string[]> = {
  'oh-my-pi': ['omp'],
};

/** Words a typed request may wrap a provider name in: "open claude", "claude agent". */
const LEADING_VERBS = /^(?:open|start|new|launch|spawn)\s+(?:an?\s+)?/;
const TRAILING_NOUN = /\s+(?:agent|session)$/;

const MAX_SUGGESTIONS = 5;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function initials(words: readonly string[]): string {
  return words.length > 1 ? words.map((word) => word.charAt(0)).join('') : '';
}

/**
 * How well `query` names `provider`: 0 is best, null is no match. Whole names and ids beat
 * prefixes, prefixes beat abbreviations, and those beat a later word ("pi" in "Oh My Pi").
 */
function rank(query: string, provider: SuggestableProvider): number | null {
  const names = [provider.label, provider.name, provider.id].map(normalize).filter(Boolean);
  const compact = query.replace(/ /g, '');
  if (names.some((name) => name === query || name.replace(/ /g, '') === compact)) return 0;
  if (names.some((name) => name.startsWith(query) || name.replace(/ /g, '').startsWith(compact))) {
    return 1;
  }
  const abbreviations = [
    ...(PROVIDER_ALIASES[provider.id] ?? []),
    ...names.map((name) => initials(name.split(' '))),
  ].filter(Boolean);
  if (abbreviations.some((abbreviation) => abbreviation.startsWith(compact))) return 2;
  const laterWords = names.flatMap((name) => name.split(' ').slice(1));
  if (laterWords.some((word) => word.startsWith(query))) return 3;
  return null;
}

/**
 * "Open Claude agent on the canvas" suggestions for what the user has typed so far. Partial names
 * match ("cl" offers Claude and Cline), and so do abbreviations ("omp" offers Oh My Pi).
 */
export function suggestAgents(
  typed: string,
  providers: readonly SuggestableProvider[]
): AgentSuggestion[] {
  const query = normalize(typed).replace(LEADING_VERBS, '').replace(TRAILING_NOUN, '').trim();
  if (!query) return [];
  return providers
    .map((provider, index) => ({ provider, index, score: rank(query, provider) }))
    .filter(
      (item): item is { provider: SuggestableProvider; index: number; score: number } =>
        item.score !== null
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ provider }) => ({
      providerId: provider.id,
      label: `Open ${provider.label} agent on the canvas`,
    }));
}
