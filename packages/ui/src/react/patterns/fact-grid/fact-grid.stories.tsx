import type { Meta, StoryObj } from '@storybook/react-vite';
import { FactGrid } from './fact-grid';

const meta: Meta<typeof FactGrid> = {
  title: 'Patterns/FactGrid',
  component: FactGrid,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof FactGrid>;

/** Detail facts for a machine, workspace, automation, PR or agent. */
export const Details: Story = {
  render: () => (
    <div style={{ maxWidth: '36rem' }}>
      <FactGrid>
        <FactGrid.Row label="Host">dev-box.tail1234.ts.net</FactGrid.Row>
        <FactGrid.Row label="Connection">Connected over Tailscale · 24 ms</FactGrid.Row>
        <FactGrid.Row label="Workspaces">3 running, 1 idle</FactGrid.Row>
        <FactGrid.Row label="Agent">Claude Code 2.1, work account</FactGrid.Row>
      </FactGrid>
    </div>
  ),
};

/** The conductor report's closing grid, at the reading size, with the move emphasised. */
export const Report: Story = {
  render: () => (
    <div style={{ maxWidth: '45rem' }}>
      <FactGrid size="reading">
        <FactGrid.Row label="You asked">
          Make ending a voice call by saying so fast, without waiting on the model.
        </FactGrid.Row>
        <FactGrid.Row label="Where it is">
          Branch fix/hang-up, pushed, not merged. Running at localhost:5173.
        </FactGrid.Row>
        <FactGrid.Row label="Your move" emphasis>
          Call Katana Dev and say “okay, you can end the call for now”.
        </FactGrid.Row>
      </FactGrid>
    </div>
  ),
};

/** Below 34rem of width each pair stacks, label over value. */
export const Narrow: Story = {
  render: () => (
    <div style={{ width: '22rem' }}>
      <FactGrid>
        <FactGrid.Row label="Branch">fix/hang-up</FactGrid.Row>
        <FactGrid.Row label="Checks">All 14 passed</FactGrid.Row>
        <FactGrid.Row label="Your move" emphasis>
          Merge when ready
        </FactGrid.Row>
      </FactGrid>
    </div>
  ),
};

/** `stackBelow="narrow"`: short values stay side by side down to 24rem (a 30rem dialog here). */
export const StackBelowNarrow: Story = {
  render: () => (
    <div style={{ width: '30rem' }}>
      <FactGrid stackBelow="narrow" labelWidth="9rem">
        <FactGrid.Row label="Host">build-box.local</FactGrid.Row>
        <FactGrid.Row label="Port">22</FactGrid.Row>
        <FactGrid.Row label="Forward SSH agent">Off</FactGrid.Row>
      </FactGrid>
    </div>
  ),
};
