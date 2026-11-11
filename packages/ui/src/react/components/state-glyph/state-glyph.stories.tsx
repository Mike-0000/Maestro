import { Box } from '@react/primitives/box';
import { Tooltip } from '@react/primitives/tooltip';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StateGlyph, STATE_GLYPH_LABELS, type StateGlyphState } from './state-glyph';
import { sx } from '@styles/utilities/sprinkles.css';

const STATES = Object.keys(STATE_GLYPH_LABELS) as StateGlyphState[];

const meta: Meta<typeof StateGlyph> = {
  title: 'Components/StateGlyph',
  component: StateGlyph,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <Tooltip.Provider delay={400}>
        <Story />
      </Tooltip.Provider>
    ),
  ],
  args: { state: 'working', label: true },
  argTypes: {
    state: { control: 'select', options: STATES },
    size: { control: 'select', options: ['sm', 'md'] },
  },
};

export default meta;
type Story = StoryObj<typeof StateGlyph>;

export const Default: Story = {};

/** The one state language (design brief 2.6): every mark with its words. */
export const AllStates: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="3">
      {STATES.map((state) => (
        <Box key={state} display="flex" alignItems="center" gap="2">
          <StateGlyph state={state} />
          <span className={sx({ fontSize: 'sm', color: 'foreground' })}>
            {STATE_GLYPH_LABELS[state]}
          </span>
        </Box>
      ))}
    </Box>
  ),
};

/** As the sidebar uses it: a task row's trailing slot, announced with a tooltip. */
export const InARow: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="1" style={{ width: '16rem' }}>
      {(
        [
          ['Login fix', 'working'],
          ['Gemini Carbon thumbnail', 'needs-you'],
          ['Lighthouse story', 'unread'],
          ['AGY shell', 'error'],
          ['Setting up worktree', 'setting-up'],
        ] as const
      ).map(([name, state]) => (
        <Box key={name} display="flex" alignItems="center" gap="2">
          <span className={sx({ flex: '1', fontSize: 'sm', color: 'foreground' })}>{name}</span>
          <StateGlyph state={state} label />
        </Box>
      ))}
    </Box>
  ),
};

/** `size="sm"` for meta lines and footers. */
export const Small: Story = {
  render: () => (
    <Box display="flex" alignItems="center" gap="3">
      {STATES.map((state) => (
        <StateGlyph key={state} state={state} size="sm" label />
      ))}
    </Box>
  ),
};
