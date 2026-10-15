export type InstalledProvider = { id: string; name: string };

/**
 * The installed provider a spoken or written provider reference means: its id or display name in
 * any case ("Claude", "claude", "Claude Code"), or null when none matches. An exact id match always
 * wins, so a provider is never swapped for a different one that merely shares a word.
 */
export function matchInstalledProvider<T extends InstalledProvider>(
  reference: string,
  installed: readonly T[]
): T | null {
  const wanted = reference.trim().toLowerCase();
  if (!wanted) return null;
  const exact = installed.find((provider) => provider.id === reference.trim());
  if (exact) return exact;
  const byName = installed.filter(
    (provider) =>
      provider.id.toLowerCase() === wanted || provider.name.trim().toLowerCase() === wanted
  );
  if (byName.length === 1) return byName[0] ?? null;
  // "Claude Code", "Codex CLI": the id followed by the product's last word.
  const loose = installed.filter((provider) => {
    const id = provider.id.toLowerCase();
    return wanted.startsWith(`${id} `) && /^(?:code|cli|agent)$/.test(wanted.slice(id.length + 1));
  });
  return loose.length === 1 ? (loose[0] ?? null) : null;
}
