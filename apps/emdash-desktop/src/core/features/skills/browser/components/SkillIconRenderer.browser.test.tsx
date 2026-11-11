import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillIconRenderer } from './SkillIconRenderer';

/** A 32px PNG: a solid square, or a dark disc on a transparent ground. */
function logo(kind: 'opaque' | 'transparent'): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#512bd4';
  if (kind === 'opaque') {
    context.fillRect(0, 0, 32, 32);
  } else {
    context.beginPath();
    context.arc(16, 16, 10, 0, Math.PI * 2);
    context.fill();
  }
  return canvas.toDataURL('image/png');
}

function skill(iconUrl: string, source: CatalogSkill['source'] = 'openai'): CatalogSkill {
  return {
    id: `logo-test-${Math.random()}`,
    displayName: 'Logo test',
    description: '',
    source,
    iconUrl,
    frontmatter: { name: 'logo-test', description: '' },
    installed: false,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SkillIconRenderer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderImage(target: CatalogSkill): Promise<HTMLImageElement> {
    await act(async () => root.render(<SkillIconRenderer skill={target} />));
    await vi.waitFor(() => {
      const tone = host.querySelector('img')?.dataset.tone;
      expect(tone === 'glyph' || tone === 'tile').toBe(true);
    });
    return host.querySelector('img')!;
  }

  it('flattens a catalog logo drawn on a transparent ground to the theme text colour', async () => {
    const image = await renderImage(skill(logo('transparent')));
    expect(image.dataset.tone).toBe('glyph');
    expect(image.className).toContain('brightness-0');
    expect(image.className).toContain('emdark:invert');
  });

  it('draws an opaque catalog logo as published instead of a solid square', async () => {
    const image = await renderImage(skill(logo('opaque')));
    expect(image.dataset.tone).toBe('tile');
    expect(image.className).not.toContain('brightness-0');
    expect(image.className).not.toContain('invert');
    expect(image.className).not.toContain('opacity-0');
  });

  it('leaves Skills.sh images untouched without measuring them', async () => {
    await act(async () =>
      root.render(<SkillIconRenderer skill={skill(logo('opaque'), 'skillssh')} />)
    );
    const image = host.querySelector('img')!;
    expect(image.dataset.tone).toBeUndefined();
    expect(image.className).not.toContain('brightness-0');
    expect(image.className).not.toContain('opacity-0');
  });
});
