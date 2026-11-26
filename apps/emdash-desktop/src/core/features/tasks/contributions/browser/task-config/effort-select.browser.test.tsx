import '@emdash/ui/style.css';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EffortSelect, type EffortOption } from './effort-select';

const options: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

const onChange = vi.fn<(effort: string | null) => void>();

function Harness({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <EffortSelect
      options={options}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

let host: HTMLDivElement;
let root: Root;

async function render(initial: string | null = null) {
  await act(async () => {
    root.render(<Harness initial={initial} />);
  });
}

const trigger = () => page.getByRole('combobox', { name: 'Effort' });

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

describe('EffortSelect', () => {
  it('reads Default while no effort is chosen', async () => {
    await render();
    await expect.element(trigger()).toHaveTextContent('Default');
  });

  it('lists Default first, then the levels lowest first', async () => {
    await render();
    await trigger().click();

    const labels = page
      .getByRole('option')
      .elements()
      .map((option) => option.textContent);
    expect(labels).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it('reports the chosen level by id', async () => {
    await render();
    await trigger().click();
    await page.getByRole('option', { name: 'Extra high', exact: true }).click();

    expect(onChange).toHaveBeenCalledExactlyOnceWith('xhigh');
    await expect.element(trigger()).toHaveTextContent('Extra high');
  });

  it('reports null when Default is picked again', async () => {
    await render('max');
    await expect.element(trigger()).toHaveTextContent('Max');

    await trigger().click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    await expect.element(trigger()).toHaveTextContent('Default');
  });

  it('reads Default for an effort the agent does not offer', async () => {
    await render('ludicrous');
    await expect.element(trigger()).toHaveTextContent('Default');
  });
});
