import '@emdash/ui/style.css';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { CloseWhenDoneField } from './CloseWhenDoneField';

const onCheckedChange = vi.fn<(checked: boolean) => void>();
const onTimeoutChange = vi.fn<(minutes: number | null) => void>();

/** The field over real state, as the automation form holds it. */
function Harness({
  initialChecked = false,
  initialTimeout = null,
  onDemand = false,
  disabled = false,
}: {
  initialChecked?: boolean;
  initialTimeout?: number | null;
  onDemand?: boolean;
  disabled?: boolean;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(initialTimeout);
  return (
    <CloseWhenDoneField
      checked={checked}
      timeoutMinutes={timeoutMinutes}
      onDemand={onDemand}
      disabled={disabled}
      onCheckedChange={(next) => {
        onCheckedChange(next);
        setChecked(next);
      }}
      onTimeoutChange={(next) => {
        onTimeoutChange(next);
        setTimeoutMinutes(next);
      }}
    />
  );
}

let host: HTMLDivElement;
let root: Root;

async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

const closeSwitch = () => page.getByRole('switch', { name: 'Close when done' });
const hours = () => page.getByRole('textbox', { name: 'Hours' });
const minutes = () => page.getByRole('textbox', { name: 'Minutes' });

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('CloseWhenDoneField', () => {
  it('is off with no time limit, and says the runs go without permission prompts', async () => {
    await render();

    await expect.element(closeSwitch()).toHaveAttribute('aria-checked', 'false');
    await expect.element(page.getByText(/without permission prompts/)).toBeVisible();
    expect(host.querySelector('[role="group"]')).toBeNull();
  });

  it('turns on and shows the time limit with the default as placeholders', async () => {
    await render();

    await closeSwitch().click();

    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
    await expect.element(closeSwitch()).toHaveAttribute('aria-checked', 'true');
    await expect.element(hours()).toHaveValue('');
    await expect.element(hours()).toHaveAttribute('placeholder', '4');
    await expect.element(minutes()).toHaveAttribute('placeholder', '0');
    await expect
      .element(page.getByRole('group', { name: 'Time limit, 4 h by default' }))
      .toBeVisible();
    expect(onTimeoutChange).not.toHaveBeenCalled();
  });

  it('commits hours and minutes as one number of minutes', async () => {
    await render({ initialChecked: true });

    await hours().fill('6');
    await userEvent.tab();
    expect(onTimeoutChange).toHaveBeenLastCalledWith(360);

    await minutes().fill('30');
    await userEvent.keyboard('{Enter}');
    expect(onTimeoutChange).toHaveBeenLastCalledWith(390);
    await expect.element(page.getByRole('group', { name: 'Time limit, 6 h 30 min' })).toBeVisible();
  });

  it('reads minutes alone as less than an hour, and clamps them to 59', async () => {
    await render({ initialChecked: true });

    await minutes().fill('75');
    await userEvent.tab();

    expect(onTimeoutChange).toHaveBeenLastCalledWith(59);
    await expect.element(hours()).toHaveValue('0');
    await expect.element(minutes()).toHaveValue('59');
  });

  it('goes back to the default when the limit is cleared or zero', async () => {
    await render({ initialChecked: true, initialTimeout: 120 });
    await expect.element(hours()).toHaveValue('2');
    await expect.element(minutes()).toHaveValue('0');

    await hours().fill('');
    await userEvent.tab();

    expect(onTimeoutChange).toHaveBeenLastCalledWith(null);
    await expect.element(hours()).toHaveValue('');
    await expect.element(minutes()).toHaveValue('');
  });

  it('does not report a change when the value is left as it was', async () => {
    await render({ initialChecked: true, initialTimeout: 90 });

    await hours().fill('1');
    await userEvent.tab();
    await userEvent.tab();

    expect(onTimeoutChange).not.toHaveBeenCalled();
  });

  it('nudges the limit with the arrow keys, starting from the default', async () => {
    await render({ initialChecked: true });

    await hours().click();
    await userEvent.keyboard('{ArrowUp}');
    expect(onTimeoutChange).toHaveBeenLastCalledWith(300);

    await minutes().click();
    await userEvent.keyboard('{ArrowDown}');
    expect(onTimeoutChange).toHaveBeenLastCalledWith(295);
  });

  it('shows off and locked on demand, with the reason, and hides the time limit', async () => {
    await render({ initialChecked: true, initialTimeout: 90, onDemand: true });

    await expect.element(closeSwitch()).toHaveAttribute('aria-checked', 'false');
    await expect.element(closeSwitch()).toBeDisabled();
    await expect.element(page.getByText(/Not used on demand/)).toBeVisible();
    expect(host.querySelector('[role="group"]')).toBeNull();
  });

  it('locks the switch and the time limit while the form cannot be edited', async () => {
    await render({ initialChecked: true, disabled: true });

    await expect.element(closeSwitch()).toBeDisabled();
    await expect.element(hours()).toBeDisabled();
    await expect.element(minutes()).toBeDisabled();
  });
});
