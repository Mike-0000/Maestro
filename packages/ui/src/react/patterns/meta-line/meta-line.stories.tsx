import type { Meta, StoryObj } from '@storybook/react-vite';
import { StateGlyph } from '../../components/state-glyph/state-glyph';
import { MetaLine } from './meta-line';

const meta: Meta<typeof MetaLine> = {
  title: 'Patterns/MetaLine',
  component: MetaLine,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof MetaLine>;

/** The conductor vitals footer: state on the left, the facts the screen knows on the right. */
export const Footer: Story = {
  render: () => (
    <div style={{ maxWidth: '45rem' }}>
      <MetaLine
        glyph={<StateGlyph state="done" size="sm" />}
        start={['Finished', '6m ago']}
        end={['Claude', 'work account', 'conductor on medium effort']}
      />
    </div>
  ),
};

/** While it needs you, the state reads a step stronger. */
export const NeedsYou: Story = {
  render: () => (
    <div style={{ maxWidth: '45rem' }}>
      <MetaLine
        glyph={<StateGlyph state="needs-you" size="sm" />}
        start={['Needs you', 'asked 2m ago']}
        end={['Codex', 'high effort']}
        strong
      />
    </div>
  ),
};

/** Under 34rem of width the trailing facts step aside. */
export const Narrow: Story = {
  render: () => (
    <div style={{ width: '20rem' }}>
      <MetaLine
        glyph={<StateGlyph state="working" size="sm" />}
        start={['Working', '14s', 'Reading the chat…']}
        end={['Claude', 'work account']}
      />
    </div>
  ),
};
