const LINK =
  'rounded-xs text-link underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring';

/** Where the catalog's skills come from, as a quiet caption note (no box, links in the link role). */
export function SkillsInfoBox() {
  return (
    <p className="max-w-2xl text-xs leading-relaxed text-foreground-muted">
      Skills from the{' '}
      <a
        href="https://github.com/openai/skills"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        OpenAI
      </a>{' '}
      and{' '}
      <a
        href="https://github.com/anthropics/skills"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        Anthropic
      </a>{' '}
      catalogs. Install a skill to make it available across all your coding agents. Skills follow
      the open{' '}
      <a href="https://agentskills.io" target="_blank" rel="noopener noreferrer" className={LINK}>
        Agent Skills
      </a>{' '}
      standard. To use skills from another library, tell us through Give feedback.
    </p>
  );
}
