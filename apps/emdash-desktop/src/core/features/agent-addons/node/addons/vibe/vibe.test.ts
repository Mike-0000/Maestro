import { describe, expect, it } from 'vitest';
import { VIBE_DEFAULT_TIER, VIBE_TIERS } from './tiers';
import { vibeAddon } from './vibe';

const files = vibeAddon.targets[0]!.files;
const fileAt = (path: string) => files.find((file) => file.path === path)?.content ?? '';

function frontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) return {};
  return Object.fromEntries(
    match[1]!.split('\n').map((line) => {
      const index = line.indexOf(':');
      return [line.slice(0, index), line.slice(index + 1).trim()];
    })
  );
}

describe('vibe add-on', () => {
  it('pins each kind of work to the agreed model and effort', () => {
    const tiers = Object.fromEntries(
      VIBE_TIERS.map((tier) => [tier.name, `${tier.modelName} ${tier.effort}`])
    );
    expect(tiers).toEqual({
      'vibe-architect': 'Fable 5.2 high',
      'vibe-planner': 'Opus 5.5 medium',
      'vibe-builder': 'Opus 5.5 medium',
      'vibe-engineer': 'Opus 5.5 high',
      'vibe-designer': 'Fable 5.2 high',
      'vibe-runner': 'Sonnet 5.5 low',
    });
    expect(VIBE_TIERS.map((tier) => tier.name)).toContain(VIBE_DEFAULT_TIER);
  });

  it('writes one agent file per tier whose frontmatter sets that model and effort', () => {
    for (const tier of VIBE_TIERS) {
      expect(frontmatter(fileAt(`agents/${tier.name}.md`))).toMatchObject({
        name: tier.name,
        model: tier.model,
        effort: tier.effort,
      });
    }
    expect(files.map((file) => file.path)).not.toContain('agents/vibe-fast.md');
    expect(files.map((file) => file.path)).not.toContain('agents/vibe-good.md');
  });

  it('tells the director the same model and effort for every tier', () => {
    const skill = fileAt('skills/vibe/SKILL.md');
    expect(skill).not.toContain('{{');
    for (const tier of VIBE_TIERS) {
      expect(skill).toContain(
        `| \`${tier.name}\` | ${tier.modelName} | \`${tier.model}\` | \`${tier.effort}\` |`
      );
    }
    expect(frontmatter(skill).name).toBe('vibe');
  });

  it('is a newer version than the vibe-fast/vibe-good release', () => {
    expect(vibeAddon.version).toBeGreaterThanOrEqual(2);
  });
});
