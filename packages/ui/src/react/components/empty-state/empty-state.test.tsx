/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './empty-state';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EmptyState', () => {
  it('renders the title, sentence and action as a panel by default', () => {
    const { container } = render(
      <EmptyState
        label="No servers yet"
        description="Add one to share tools with your agents."
        action={<button type="button">Add server</button>}
      />
    );
    const root = container.querySelector('[data-slot="empty-state"]');
    expect(root?.getAttribute('data-size')).toBe('panel');
    expect(screen.getByRole('heading', { name: 'No servers yet' })).not.toBeNull();
    expect(screen.getByText('Add one to share tools with your agents.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Add server' })).not.toBeNull();
  });

  it('marks the page size', () => {
    const { container } = render(<EmptyState size="page" label="Nothing needs you" />);
    expect(container.querySelector('[data-slot="empty-state"]')?.getAttribute('data-size')).toBe(
      'page'
    );
  });

  it('puts technical detail behind a Show details disclosure in the error tone', () => {
    const { container } = render(
      <EmptyState tone="error" label="Could not load" details="ECONNREFUSED 127.0.0.1:8080" />
    );
    expect(container.querySelector('[data-tone="error"]')).not.toBeNull();
    expect(screen.getByText('Show details').tagName).toBe('SUMMARY');
    expect(screen.getByText('ECONNREFUSED 127.0.0.1:8080')).not.toBeNull();
  });

  it('waits before showing the loading state', () => {
    vi.useFakeTimers();
    render(<EmptyState tone="loading" label="Loading branches…" delayMs={400} />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Loading branches…')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText('Loading branches…')).not.toBeNull();
  });
});
