import { Button } from '@react/primitives/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './empty-state';

const meta: Meta<typeof EmptyState> = {
  title: 'Components/EmptyState',
  component: EmptyState,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: '20rem', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    label: 'No tasks yet',
  },
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {};

export const WithDescription: Story = {
  args: {
    label: 'No pull requests',
    description: 'Pull requests opened from this project will show up here.',
  },
};

export const WithAction: Story = {
  args: {
    label: 'No terminals open',
    description: 'Open a terminal to run commands in this workspace.',
    action: <Button variant="text">New terminal</Button>,
  },
};

/**
 * `size="page"`: a whole view or pane (the conductor's empty screen): the hero
 * title, one sentence, and the screen's one move.
 */
export const Page: Story = {
  args: {
    size: 'page',
    label: 'Nothing needs you right now.',
    description: 'Three tasks are at work. You will hear from them when one is ready to try.',
    action: <Button variant="primary">New task</Button>,
  },
  decorators: [
    (Story) => (
      <div style={{ height: '28rem', display: 'flex', flex: 1 }}>
        <Story />
      </div>
    ),
  ],
};

/** `tone="error"`: the error dot, plain words, Try again, details behind a disclosure. */
export const ErrorState: Story = {
  args: {
    tone: 'error',
    label: 'Could not load branches',
    description: 'The remote did not answer. Check the connection and try again.',
    action: <Button variant="text">Try again</Button>,
    details:
      "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
  },
};

/** `tone="loading"`: a passive spinner and one muted line, after a 400ms delay. */
export const LoadingState: Story = {
  args: {
    tone: 'loading',
    label: 'Loading branches…',
    delayMs: 0,
  },
};

/**
 * `bare` drops the panel background for containers that paint their own
 * surface (e.g. `CollectionView`'s card). The striped backdrop here shows
 * through to make the transparency visible.
 */
export const Bare: Story = {
  args: {
    label: 'No pull requests',
    description: 'Rendered with `bare` — the container behind shows through.',
    bare: true,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          flex: 1,
          display: 'flex',
          background:
            'repeating-linear-gradient(45deg, rgba(128,128,128,0.12) 0 12px, transparent 12px 24px)',
        }}
      >
        <Story />
      </div>
    ),
  ],
};
