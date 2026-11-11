import type { AddonDefinition } from '../../addon-definition';
import instructions from './instructions.md?raw';
import skillTemplate from './SKILL.md?raw';
import { renderTierTable, renderWorker, VIBE_TIERS } from './tiers';

const skill = skillTemplate.replace('{{VIBE_TIERS}}', renderTierTable());

/**
 * oh-my-pi's /vibe for Claude Code: a director that routes work to tiered workers, each pinned
 * to a model and effort level in `tiers.ts`. Version 2 replaced the vibe-fast and vibe-good
 * workers; the installer deletes their unedited files when an install updates to it. Version 3
 * lowered each tier's standard effort one level (planner and builder stay at medium) and added
 * pro mode, which raises every tier one level.
 */
export const vibeAddon: AddonDefinition = {
  id: 'vibe',
  name: 'Vibe mode',
  summary: 'Claude directs tiered worker agents, each pinned to a model and effort level',
  description:
    'Adds the /vibe skill (also called director mode), after oh-my-pi. Claude stops editing ' +
    'and running things itself and routes work to persistent worker agents by kind: ' +
    'vibe-architect (Fable, medium) for high-level planning, vibe-planner (Opus, medium) for ' +
    'light planning, vibe-builder (Opus, medium) for light implementation, vibe-engineer ' +
    '(Opus, medium) for heavy implementation, vibe-designer (Fable, medium) for new front-end ' +
    'design and styles, and vibe-runner (Sonnet, low) for running checks. Pro mode (/vibe pro) ' +
    'raises every tier one effort level. It verifies their ' +
    'results by reading the files they touched. The instructions let Claude choose vibe mode ' +
    'on its own for tasks that split into several workstreams. Maestro updates it ' +
    'automatically when a new version ships, unless you edited its files.',
  version: 3,
  targets: [
    {
      providerId: 'claude',
      files: [
        { path: 'skills/vibe/SKILL.md', content: skill },
        ...VIBE_TIERS.map((tier) => ({
          path: `agents/${tier.name}.md`,
          content: renderWorker(tier),
        })),
      ],
      instructions: { path: 'CLAUDE.md', content: instructions },
    },
  ],
};
