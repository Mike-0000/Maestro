import { Box } from '@react/primitives/box';
import { Surface } from '@react/primitives/surface/surface';
import { Textarea } from '@react/primitives/textarea';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { cx } from '@styles/utilities/cx';
import * as s from '@react/story-layout.css';
import { sx } from '@styles/utilities/sprinkles.css';

const meta: Meta<typeof Textarea> = {
  title: 'Primitives/Textarea',
  component: Textarea,
  parameters: { layout: 'centered' },
  argTypes: {
    size: { control: 'select', options: ['base', 'sm'] },
  },
};

export default meta;
type Story = StoryObj<typeof Textarea>;

export const Default: Story = {
  render: () => (
    <Box className={s.w64}>
      <Textarea placeholder="Enter text…" />
    </Box>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="3" className={s.w64}>
      <Textarea size="base" placeholder="Base size textarea" />
      <Textarea size="sm" placeholder="Small size textarea" />
    </Box>
  ),
};

export const WithValue: Story = {
  render: () => (
    <Box className={s.w64}>
      <Textarea defaultValue="Some longer text that wraps over multiple lines in the textarea." />
    </Box>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Box className={s.w64}>
      <Textarea placeholder="Disabled" disabled />
    </Box>
  ),
};

/**
 * `bare`: no border, fill or focus ring of its own, for a textarea inside a card
 * that already draws the edge (mirrors `Input bare`). The card shows focus.
 */
export const Bare: Story = {
  render: () => (
    <Surface
      level="elevated"
      className={cx(
        s.w64,
        sx({
          rounded: 'lg',
          borderWidth: '1',
          borderStyle: 'solid',
          borderColor: 'borderSubtle',
          padding: '1',
        })
      )}
    >
      <Textarea bare placeholder="Add a note about this line…" />
    </Surface>
  ),
};

/**
 * The textarea's box (height, min-height, padding) sits in the recipes layer,
 * so utilities override it without inline styles: here sx() padding.
 */
export const PaddingFromUtilities: Story = {
  render: () => (
    <Box className={s.w64}>
      <Textarea className={sx({ padding: '4' })} placeholder="Roomier padding from sx()" />
    </Box>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Box className={s.w64}>
      <Textarea placeholder="Invalid" aria-invalid="true" />
    </Box>
  ),
};
