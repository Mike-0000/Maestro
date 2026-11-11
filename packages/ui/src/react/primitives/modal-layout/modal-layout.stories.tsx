import { Box } from '@react/primitives/box';
import { Button } from '@react/primitives/button';
import { Dialog } from '@react/primitives/dialog';
import { Field } from '@react/primitives/field';
import { Input } from '@react/primitives/input';
import { Text } from '@react/primitives/typography/Text';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ModalLayout } from '.';

const meta: Meta = {
  title: 'Primitives/ModalLayout',
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj;

function SteppedModalContent() {
  const [step, setStep] = useState<1 | 2>(1);
  return (
    <ModalLayout
      header={
        <Dialog.Header>
          <Dialog.Title>{step === 1 ? 'Choose a name' : 'Confirm details'}</Dialog.Title>
        </Dialog.Header>
      }
      footer={
        <Dialog.Footer>
          {step === 2 && (
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
          )}
          {step === 1 ? (
            <Button variant="primary" onClick={() => setStep(2)}>
              Next
            </Button>
          ) : (
            <Dialog.Close render={<Button variant="primary">Create</Button>} />
          )}
        </Dialog.Footer>
      }
    >
      <Dialog.Body>
        {step === 1 ? (
          <Input placeholder="Project name" />
        ) : (
          <Box display="flex" flexDirection="column" gap="2">
            <Text variant="description">
              The header and footer stay put while this middle section height-animates between
              steps.
            </Text>
            <Text variant="description" tone="muted">
              Step two intentionally has taller content than step one, so switching steps shows the
              animated middle expanding and collapsing.
            </Text>
          </Box>
        )}
      </Dialog.Body>
    </ModalLayout>
  );
}

export const SteppedComposition: Story = {
  render: () => (
    <Dialog.Root>
      <Dialog.Trigger render={<Button variant="ghost">Open stepped modal</Button>} />
      <Dialog.Content>
        <SteppedModalContent />
      </Dialog.Content>
    </Dialog.Root>
  ),
};

/**
 * The standard form dialog via the shorthand props (design brief 2.9): title and
 * one sentence, a `gap-5` body, Cancel as ghost, the one primary rightmost and a
 * Learn more text action on the left.
 */
export const StandardForm: Story = {
  render: () => (
    <Dialog.Root>
      <Dialog.Trigger render={<Button variant="ghost">Open form dialog</Button>} />
      <Dialog.Content size="md">
        <ModalLayout
          title="Rename project"
          description="The folder on disk keeps its name; only Maestro's label changes."
          leading={<Button variant="text">Learn more</Button>}
          actions={
            <>
              <Dialog.Close render={<Button variant="ghost">Cancel</Button>} />
              <Dialog.Close render={<Button variant="primary">Rename</Button>} />
            </>
          }
        >
          <Dialog.Body>
            <Field.Root>
              <Field.Label>Name</Field.Label>
              <Input defaultValue="chorus" />
              <Field.Description>Shown in the sidebar and the title bar.</Field.Description>
            </Field.Root>
          </Dialog.Body>
        </ModalLayout>
      </Dialog.Content>
    </Dialog.Root>
  ),
};
