import type { Meta, StoryObj } from '@storybook/react-vite';
import { DirectoryField } from './index';

const meta: Meta<typeof DirectoryField> = {
  title: 'Primitives/DirectoryField',
  component: DirectoryField,
  parameters: { layout: 'centered' },
  render: (args) => (
    <div style={{ width: '24rem' }}>
      <DirectoryField {...args} />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof DirectoryField>;

export const Placeholder: Story = {
  args: {
    placeholder: 'Select a directory',
    onClick: noop,
  },
};

export const WithPath: Story = {
  args: {
    path: '/Users/david/Documents/repos/emdash',
    onClick: noop,
  },
};

/**
 * A long POSIX path truncates at its start, so the folder name stays visible.
 * Hover shows the full path.
 */
export const LongPosixPath: Story = {
  args: {
    path: '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/clients/a-very-long-client-name/repositories/monorepo-with-a-long-name/emdash',
    onClick: noop,
  },
};

/** A long Windows path: drive letter, backslashes and spaces keep their order. */
export const LongWindowsPath: Story = {
  args: {
    path: 'C:\\Users\\someone\\OneDrive - Example Organisation\\Documents\\Source\\clients\\a-very-long-client-name\\repositories\\emdash (fork)',
    onClick: noop,
  },
};

/** Both at the small size, side by side with a path that fits. */
export const LongPathsSmall: Story = {
  render: () => (
    <div style={{ width: '18rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <DirectoryField size="sm" path="~/repos/emdash" onClick={noop} />
      <DirectoryField
        size="sm"
        path="/home/someone/projects/archive/2026/a-deeply-nested-folder/my-project"
        onClick={noop}
      />
      <DirectoryField
        size="sm"
        path={'D:\\work\\clients\\example\\very\\deep\\folder\\structure\\my-project'}
        onClick={noop}
      />
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
    placeholder: 'Select a machine first',
    onClick: noop,
  },
};

export const Small: Story = {
  args: {
    size: 'sm',
    path: '~/repos/emdash',
    onClick: noop,
  },
};

function noop() {}
