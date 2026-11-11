/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MetaLine } from '../meta-line/meta-line';
import { FactGrid } from './fact-grid';

afterEach(cleanup);

describe('FactGrid', () => {
  it('renders label / value pairs as a definition list', () => {
    const { container } = render(
      <FactGrid labelWidth="7rem">
        <FactGrid.Row label="Branch">fix/hang-up</FactGrid.Row>
        <FactGrid.Row label="Your move" emphasis>
          Try it
        </FactGrid.Row>
      </FactGrid>
    );
    const dl = container.querySelector('dl[data-slot="fact-grid"]') as HTMLElement | null;
    expect(dl).not.toBeNull();
    expect(dl?.style.getPropertyValue('--fact-grid-label-width')).toBe('7rem');
    expect([...container.querySelectorAll('dt')].map((n) => n.textContent)).toEqual([
      'Branch',
      'Your move',
    ]);
    expect([...container.querySelectorAll('dd')].map((n) => n.textContent)).toEqual([
      'fix/hang-up',
      'Try it',
    ]);
  });
});

describe('FactGrid stackBelow', () => {
  it('keys the stacking threshold on data-stack (default, narrow, never)', () => {
    const grid = (props: { stackBelow?: 'default' | 'narrow' | 'never' }) =>
      render(
        <FactGrid {...props}>
          <FactGrid.Row label="Host">example.com</FactGrid.Row>
        </FactGrid>
      ).container.querySelector('dl[data-slot="fact-grid"]');
    expect(grid({})?.getAttribute('data-stack')).toBe('default');
    expect(grid({ stackBelow: 'narrow' })?.getAttribute('data-stack')).toBe('narrow');
    expect(grid({ stackBelow: 'never' })?.getAttribute('data-stack')).toBe('never');
  });
});

describe('MetaLine', () => {
  it('joins facts with a middle dot and drops empty ones', () => {
    const { container } = render(
      <MetaLine start={['Finished', null, '6m ago']} end={['Claude', false, 'work account']} />
    );
    const text = container.querySelector('[data-slot="meta-line"]')?.textContent;
    expect(text).toBe('Finished · 6m agoClaude · work account');
  });

  it('renders nothing on the right when there are no trailing facts', () => {
    const { container } = render(<MetaLine start="Working" end={[]} />);
    expect(container.querySelector('[data-slot="meta-line"]')?.children.length).toBe(1);
  });
});
