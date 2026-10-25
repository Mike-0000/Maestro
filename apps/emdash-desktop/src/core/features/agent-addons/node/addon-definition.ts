/**
 * An add-on: a bundle of agent capabilities Maestro can install into a provider's config folder
 * on any host. Each target is one provider, with the files the add-on owns (paths relative to
 * that provider's config folder, such as `skills/vibe/SKILL.md` under `~/.claude`) and at most
 * one block of standing instructions for its shared instructions file. Raise `version` whenever
 * the content changes, so installed copies show as having an update.
 */
export type AddonDefinition = {
  /** Lowercase letters, digits, and dashes; also names the instructions block. */
  id: string;
  name: string;
  /** One line for the card. */
  summary: string;
  /** What it does and when an agent uses it, for the detail view. */
  description: string;
  version: number;
  targets: AddonTarget[];
};

export type AddonTarget = {
  providerId: string;
  files: { path: string; content: string }[];
  instructions?: { path: string; content: string };
};
