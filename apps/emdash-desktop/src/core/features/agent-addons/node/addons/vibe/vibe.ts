import type { AddonDefinition } from '../../addon-definition';
import instructions from './instructions.md?raw';
import skill from './SKILL.md?raw';
import fastWorker from './vibe-fast.md?raw';
import goodWorker from './vibe-good.md?raw';

/** oh-my-pi's /vibe for Claude Code: a director that runs fast and strong worker agents. */
export const vibeAddon: AddonDefinition = {
  id: 'vibe',
  name: 'Vibe mode',
  summary: 'Claude directs fast and strong worker agents and checks their work',
  description:
    'Adds the /vibe skill (also called director mode), after oh-my-pi. Claude stops editing ' +
    'and running things itself and directs persistent worker agents instead: vibe-fast for ' +
    'mechanical work and vibe-good for design, debugging, and review. It verifies their ' +
    'results by reading the files they touched. The instructions let Claude choose vibe mode ' +
    'on its own for tasks that split into several workstreams, so you never have to ask.',
  version: 1,
  targets: [
    {
      providerId: 'claude',
      files: [
        { path: 'skills/vibe/SKILL.md', content: skill },
        { path: 'agents/vibe-fast.md', content: fastWorker },
        { path: 'agents/vibe-good.md', content: goodWorker },
      ],
      instructions: { path: 'CLAUDE.md', content: instructions },
    },
  ],
};
