import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn with the app type scale', () => {
  it('keeps a custom font size next to a text colour', () => {
    expect(cn('text-tiny', 'text-foreground-passive')).toBe('text-tiny text-foreground-passive');
    expect(cn('text-micro text-foreground-muted')).toBe('text-micro text-foreground-muted');
  });

  it('lets a later font size override an earlier one', () => {
    expect(cn('text-tiny', 'text-sm')).toBe('text-sm');
    expect(cn('text-sm', 'text-micro')).toBe('text-micro');
    expect(cn('text-micro text-foreground-muted', 'text-tiny')).toBe(
      'text-foreground-muted text-tiny'
    );
  });

  it('still lets a later colour override an earlier one', () => {
    expect(cn('text-tiny text-foreground-muted', 'text-foreground-passive')).toBe(
      'text-tiny text-foreground-passive'
    );
  });
});
