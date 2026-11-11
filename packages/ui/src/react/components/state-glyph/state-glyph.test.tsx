/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Tooltip } from '../../primitives/tooltip';
import { StateGlyph, STATE_GLYPH_LABELS, type StateGlyphState } from './state-glyph';

afterEach(cleanup);

// jsdom has no matchMedia; the braille spinner asks it about reduced motion.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

const STATES = Object.keys(STATE_GLYPH_LABELS) as StateGlyphState[];

describe('StateGlyph', () => {
  it.each(STATES)('renders %s as a decorative mark when no label is given', (state) => {
    const { container } = render(<StateGlyph state={state} />);
    const glyph = container.querySelector('[data-slot="state-glyph"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('data-state')).toBe(state);
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('role')).toBeNull();
  });

  it('announces the default words of the state when label is true', () => {
    render(
      <Tooltip.Provider>
        <StateGlyph state="needs-you" label />
      </Tooltip.Provider>
    );
    expect(screen.getByRole('img', { name: 'Needs you' })).not.toBeNull();
  });

  it('announces custom words', () => {
    render(
      <Tooltip.Provider>
        <StateGlyph state="error" label="Build failed" />
      </Tooltip.Provider>
    );
    expect(screen.getByRole('img', { name: 'Build failed' })).not.toBeNull();
  });

  it('draws the braille spinner while setting up', () => {
    const { container } = render(<StateGlyph state="setting-up" />);
    const glyph = container.querySelector('[data-slot="state-glyph"]');
    // The spinner renders a braille frame as text; the other states draw an empty mark.
    expect(glyph?.textContent?.length).toBeGreaterThan(0);
  });
});
