import { Box } from '@react/primitives/box';
import { Button } from '@react/primitives/button';
import { Popover } from '@react/primitives/popover';
import { Surface } from '@react/primitives/surface/surface';
import { Text } from '@react/primitives/typography/Text';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { AnimatedHeight } from '.';

const meta: Meta = {
  title: 'Primitives/AnimatedHeight',
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj;

const PARAGRAPHS = [
  'AnimatedHeight smoothly transitions its own height whenever the content inside changes size.',
  'Adding more content grows the box with a 0.25s ease transition instead of jumping.',
  'Removing content shrinks it just as smoothly. The initial mount never animates.',
  'Overflow is only clipped while the transition is running, so popovers rendered inside can escape the box at rest.',
];

export const ExpandingCollapsing: Story = {
  render: function ExpandingCollapsingStory() {
    const [count, setCount] = useState(1);
    return (
      <Box display="flex" flexDirection="column" gap="3" style={{ width: '22rem' }}>
        <Box display="flex" gap="2">
          <Button size="sm" onClick={() => setCount((c) => Math.min(c + 1, PARAGRAPHS.length))}>
            Add paragraph
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setCount((c) => Math.max(c - 1, 1))}>
            Remove paragraph
          </Button>
        </Box>
        <Surface level="elevated" style={{ padding: '0.75rem', borderRadius: '0.5rem' }}>
          <AnimatedHeight>
            <Box display="flex" flexDirection="column" gap="2">
              {PARAGRAPHS.slice(0, count).map((paragraph) => (
                <Text key={paragraph} as="p" variant="description">
                  {paragraph}
                </Text>
              ))}
            </Box>
          </AnimatedHeight>
        </Surface>
      </Box>
    );
  },
};

export const OverflowReleased: Story = {
  render: function OverflowReleasedStory() {
    const [expanded, setExpanded] = useState(false);
    return (
      <Box display="flex" flexDirection="column" gap="3" style={{ width: '22rem' }}>
        <Text variant="description" tone="muted">
          Once the height transition settles, overflow is released — the popover below escapes the
          animated box instead of being clipped by it.
        </Text>
        <Surface level="elevated" style={{ padding: '0.75rem', borderRadius: '0.5rem' }}>
          <AnimatedHeight>
            <Box display="flex" flexDirection="column" gap="2" alignItems="flex-start">
              <Button size="sm" variant="secondary" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Collapse' : 'Expand'}
              </Button>
              {expanded ? (
                <Popover.Root>
                  <Popover.Trigger render={<Button size="sm">Open popover</Button>} />
                  <Popover.Content>
                    <Text variant="description">This popover escapes the AnimatedHeight box.</Text>
                  </Popover.Content>
                </Popover.Root>
              ) : null}
            </Box>
          </AnimatedHeight>
        </Surface>
      </Box>
    );
  },
};

const LONG_PATH =
  '/Users/someone/Library/Application-Support/very-long-organisation-name/monorepo-with-a-long-name/packages/a-deeply-nested-package/src/components/feature-folder';

/**
 * A long unbreakable value inside the animated box. The grid's one column is
 * `minmax(0, 1fr)`, so the box keeps its width and the value truncates inside
 * its field instead of pushing the content past the container's edge.
 */
export const LongUnbreakableValue: Story = {
  render: () => (
    <Surface
      level="elevated"
      style={{ width: '22rem', padding: '0.75rem', borderRadius: '0.5rem' }}
    >
      <AnimatedHeight>
        <Box display="flex" flexDirection="column" gap="2">
          <Text variant="description" tone="muted">
            Folder
          </Text>
          <Text
            variant="description"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {LONG_PATH}
          </Text>
        </Box>
      </AnimatedHeight>
    </Surface>
  ),
};

/**
 * The content swaps from a short loading line to the real body right after
 * mount, between the initial measurement and ResizeObserver's first callback.
 * The box follows the new height instead of staying at the loading height.
 */
export const LoadsRightAfterMount: Story = {
  render: function LoadsRightAfterMountStory() {
    const [loaded, setLoaded] = useState(false);
    // A parent effect runs after AnimatedHeight's own effects (it has measured
    // and started observing), but before the first ResizeObserver callback.
    useEffect(() => setLoaded(true), []);
    return (
      <Surface
        level="elevated"
        style={{ width: '22rem', padding: '0.75rem', borderRadius: '0.5rem' }}
      >
        <AnimatedHeight>
          {loaded ? (
            <Box display="flex" flexDirection="column" gap="2">
              {PARAGRAPHS.map((paragraph) => (
                <Text key={paragraph} as="p" variant="description">
                  {paragraph}
                </Text>
              ))}
            </Box>
          ) : (
            <Text variant="description" tone="muted">
              Loading…
            </Text>
          )}
        </AnimatedHeight>
      </Surface>
    );
  },
};
