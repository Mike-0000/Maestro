/**
 * The vibe worker tiers: one place that pins each kind of work to a model and an effort level.
 * Every worker's agent file and the director's routing table in SKILL.md are generated from this
 * list, so the frontmatter Claude Code reads and the `model`/`effort` the director passes on each
 * spawn can never drift apart.
 *
 * `model` is a Claude Code alias (it accepts it in agent frontmatter and in the Agent tool's
 * `model` field) and always resolves to the newest model of that family; `modelName` is the model
 * it means today, shown to the user and the director.
 */
export type VibeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type VibeTier = {
  /** Agent name, and the `subagent_type` the director spawns. */
  name: string;
  /** Short role name for tables and the roster. */
  role: string;
  model: 'fable' | 'opus' | 'sonnet' | 'haiku';
  modelName: string;
  /** Standard effort, which the agent file pins. */
  effort: VibeEffort;
  /** Effort the director passes instead while pro mode is on: one level higher. */
  proEffort: VibeEffort;
  /** One line for the routing table: what work goes to this tier. */
  routing: string;
  /** Frontmatter description Claude Code shows in its agent list. */
  description: string;
  /** The tier-specific paragraph of the worker's system prompt. */
  brief: string;
  /** Planners and runners report; they don't change files. */
  edits: boolean;
};

export const VIBE_TIERS: readonly VibeTier[] = [
  {
    name: 'vibe-architect',
    role: 'Architect',
    model: 'fable',
    modelName: 'Fable 5.2',
    effort: 'medium',
    proEffort: 'high',
    routing:
      'High-level and intense planning: architecture, system design with real trade-offs, ' +
      'splitting a large feature into workstreams, plans for risky or wide changes',
    description:
      'Vibe-mode architect (Fable, medium effort; high in pro mode) for high-level and intense planning: architecture, design trade-offs, and plans for large or risky work. Spawned only by the /vibe director.',
    brief:
      'You get the hardest thinking: high-level plans, architecture, and design with real ' +
      'trade-offs. Investigate the code as deeply as the decision needs, weigh the options, ' +
      'and commit to one. Your output is a plan the director hands to other workers, so make ' +
      'it concrete: the files, the order of steps, the interfaces between parts, the risks, ' +
      'and observable acceptance criteria for each workstream.',
    edits: false,
  },
  {
    name: 'vibe-planner',
    role: 'Planner',
    model: 'opus',
    modelName: 'Opus 5.5',
    effort: 'medium',
    proEffort: 'high',
    routing:
      'Light planning and investigation: scope a small change, find where code lives, ' +
      'map a clear task into steps, answer a focused question about the codebase',
    description:
      'Vibe-mode planner (Opus, medium effort; high in pro mode) for light planning and focused investigation: scoping small changes and mapping clear tasks into steps. Spawned only by the /vibe director.',
    brief:
      'You get light planning and investigation: scoping a small change, finding where code ' +
      'lives, and turning a clear request into concrete steps. Keep it proportionate; read ' +
      'what the question needs and no more. If the work turns out to need architecture or ' +
      'deep trade-offs, say so and stop, so the director can hand it to the architect.',
    edits: false,
  },
  {
    name: 'vibe-builder',
    role: 'Builder',
    model: 'opus',
    modelName: 'Opus 5.5',
    effort: 'medium',
    proEffort: 'high',
    routing:
      'Light implementation, and the default for anything unclassified: well-specified ' +
      'edits, small fixes, renames, boilerplate, tests that follow existing patterns, ' +
      'wiring existing components',
    description:
      'Vibe-mode builder (Opus, medium effort; high in pro mode) for light, well-specified implementation and the default for unclassified work. Spawned only by the /vibe director.',
    brief:
      'You get light implementation: well-specified edits, small fixes, renames, ' +
      'boilerplate, and tests that follow existing patterns. Follow the conventions already ' +
      'in the code. If the brief turns out to need design decisions, new visual styling, or ' +
      'judgment it did not cover, stop and say so instead of guessing.',
    edits: true,
  },
  {
    name: 'vibe-engineer',
    role: 'Engineer',
    model: 'opus',
    modelName: 'Opus 5.5',
    effort: 'medium',
    proEffort: 'high',
    routing:
      'Heavy implementation: multi-file features, refactors, tricky debugging, concurrency, ' +
      'security, data and migrations, and reviewing builder output on risky changes',
    description:
      'Vibe-mode engineer (Opus, medium effort; high in pro mode) for heavy implementation: multi-file features, refactors, tricky debugging, risky areas, and code review. Spawned only by the /vibe director.',
    brief:
      'You get heavy implementation: multi-file features, refactors, tricky debugging, and ' +
      'risky areas such as concurrency, security, data, and migrations. You also review ' +
      "other workers' changes when the director asks. When a decision matters, make it, and " +
      'say what you chose and why. Leave new visual design to the designer.',
    edits: true,
  },
  {
    name: 'vibe-designer',
    role: 'Designer',
    model: 'fable',
    modelName: 'Fable 5.2',
    effort: 'medium',
    proEffort: 'high',
    routing:
      'Front-end design: anything that invents new UI, layout, CSS, styles, theme tokens, ' +
      'motion, or visual polish, and reviews of how a UI looks',
    description:
      'Vibe-mode designer (Fable, medium effort; high in pro mode) for front-end design: new UI, layouts, CSS, styles, theme tokens, and visual polish. Spawned only by the /vibe director.',
    brief:
      'You get front-end design: inventing new UI, layouts, CSS, styles, theme tokens, ' +
      'motion, and visual polish, and reviewing how an interface looks. Start from the ' +
      "project's design system, tokens, and UI primitives, and extend them rather than " +
      'working around them. Check light and dark themes, narrow widths, and keyboard focus. ' +
      'Describe the visual decisions you made so the director can judge them.',
    edits: true,
  },
  {
    name: 'vibe-runner',
    role: 'Runner',
    model: 'sonnet',
    modelName: 'Sonnet 5.5',
    effort: 'low',
    proEffort: 'medium',
    routing:
      'Quick bounded checks with no judgment: run tests, builds, or linters and report, ' +
      'find files, grep for a pattern, collect facts',
    description:
      'Vibe-mode runner (Sonnet, low effort; medium in pro mode) for quick bounded checks: running tests, builds, and linters, finding files, and collecting facts. Spawned only by the /vibe director.',
    brief:
      'You get quick, bounded checks: run tests, builds, or linters, find files, grep for ' +
      'patterns, and collect facts. Report exactly what you saw, with failing test names and ' +
      'the relevant lines of output. Do not try to fix what you find; the director decides.',
    edits: false,
  },
];

/** The tier for work that fits no other row. */
export const VIBE_DEFAULT_TIER = 'vibe-builder';

/** The agent file Claude Code loads for one tier. */
export function renderWorker(tier: VibeTier): string {
  const scope = tier.edits
    ? [
        '- Do the assigned work and nothing else. Edit files, create files, and run commands as',
        '  the task needs. Prefer editing existing files to creating new ones.',
        "- Stay out of files the brief didn't give you; another worker may be editing them.",
      ]
    : [
        '- Do the assigned work and nothing else. Read files and run read-only commands as the',
        "  task needs, but don't edit or create files: report back and let the director route",
        '  the changes.',
      ];
  const report = [
    tier.edits ? '- **Files changed:** each path, with one line on what changed.' : null,
    tier.edits ? null : '- **Findings:** the plan, answer, or facts, as the brief asked.',
    '- **Commands run:** each command, with its result (for tests, pass/fail counts).',
    tier.name === 'vibe-runner' ? null : '- **Decisions:** any choice you made and why.',
    '- **Status:** done, or what is left and why.',
    '- **Open questions:** anything the director must decide.',
  ].filter((line): line is string => line !== null);

  return [
    '---',
    `name: ${tier.name}`,
    `description: ${tier.description}`,
    `model: ${tier.model}`,
    `effort: ${tier.effort}`,
    '---',
    '',
    `You are the ${tier.role.toLowerCase()} worker in vibe mode (${tier.modelName}, ${tier.effort}`,
    `effort, or ${tier.proEffort} when the director runs pro mode), taking direction from a ` +
      'director agent. The director cannot see your tool calls,',
    'only your final message, and it may send you follow-ups on the same workstream later.',
    '',
    tier.brief,
    '',
    ...scope,
    "- Don't spawn sub-agents of your own and don't create documentation files unless asked.",
    '- Avoid full-file reads unless they are needed.',
    '',
    'End every turn with a short report, as notes for the director:',
    '',
    ...report,
    '',
  ].join('\n');
}

/** The routing table the director reads in SKILL.md. */
export function renderTierTable(): string {
  const rows = VIBE_TIERS.map(
    (tier) =>
      `| \`${tier.name}\` | ${tier.modelName} | \`${tier.model}\` | \`${tier.effort}\` | ` +
      `\`${tier.proEffort}\` | ${tier.routing} |`
  );
  return [
    '| Tier (`subagent_type`) | Model | `model` | `effort` | `effort` in pro mode | Use it for |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
