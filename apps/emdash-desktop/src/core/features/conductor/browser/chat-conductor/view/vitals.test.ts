import { describe, expect, it } from 'vitest';
import { conductorVitals, formatAge, type ConductorVitalsInput } from './vitals';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1_000).toISOString();

const base: ConductorVitalsInput = {
  state: 'idle',
  busy: false,
  activity: null,
  busySinceMs: null,
  lastEntryAt: null,
  lastEntryKind: null,
  nowMs: NOW,
  providerLabel: null,
  accountLabel: null,
  conductorEffort: null,
};
const vitals = (patch: Partial<ConductorVitalsInput>) => conductorVitals({ ...base, ...patch });

describe('conductorVitals', () => {
  it('says Idle for an empty thread, an idle conductor and no status yet', () => {
    expect(vitals({})).toEqual({ glyph: 'idle', left: 'Idle', facts: [] });
    expect(vitals({ state: null })).toMatchObject({ glyph: 'idle', left: 'Idle' });
    expect(vitals({ lastEntryAt: ago(60), lastEntryKind: 'conductor' })).toMatchObject({
      glyph: 'idle',
      left: 'Idle',
    });
  });

  it('shows a conductor turn with its elapsed time and activity', () => {
    expect(
      vitals({ busy: true, busySinceMs: NOW - 14_000, activity: 'Reading the chat…' })
    ).toMatchObject({ glyph: 'working', left: 'Working · 14s · Reading the chat…' });
    expect(vitals({ busy: true, busySinceMs: NOW - 94_000 })).toMatchObject({
      left: 'Working · 1m 34s',
    });
    expect(vitals({ busy: true, activity: 'Thinking…' })).toMatchObject({
      left: 'Working · Thinking…',
    });
  });

  it('puts a conductor turn before the status it may change', () => {
    expect(
      vitals({ busy: true, busySinceMs: NOW, state: 'needs_you', lastEntryKind: 'error' })
    ).toMatchObject({ glyph: 'working', left: 'Working · 0s' });
  });

  it('shows agents at work with the age of the last news', () => {
    expect(vitals({ state: 'working', lastEntryAt: ago(120) })).toMatchObject({
      glyph: 'working',
      left: 'Working · last news 2m ago',
    });
    expect(vitals({ state: 'working' })).toMatchObject({ left: 'Working' });
  });

  it('shows how long the developer has been waited on', () => {
    expect(vitals({ state: 'needs_you', lastEntryAt: ago(32) })).toMatchObject({
      glyph: 'needs_you',
      left: 'Needs you · waiting 32s',
    });
    expect(vitals({ state: 'needs_you', lastEntryAt: ago(5 * 60 + 3) })).toMatchObject({
      left: 'Needs you · waiting 5m 3s',
    });
    expect(vitals({ state: 'needs_you' })).toMatchObject({ left: 'Needs you' });
  });

  it('shows when the work finished', () => {
    expect(vitals({ state: 'done', lastEntryAt: ago(6 * 60) })).toMatchObject({
      glyph: 'done',
      left: 'Finished · 6m ago',
    });
    expect(vitals({ state: 'done', lastEntryAt: ago(1) })).toMatchObject({
      left: 'Finished · now',
    });
    expect(vitals({ state: 'done' })).toMatchObject({ left: 'Finished' });
  });

  it('says it stopped on an error when the last entry is one', () => {
    expect(vitals({ state: 'working', lastEntryAt: ago(3), lastEntryKind: 'error' })).toEqual({
      glyph: 'error',
      left: 'Stopped on an error',
      facts: [],
    });
  });

  it('lists the provider, account and conductor effort it knows, in that order', () => {
    expect(
      vitals({
        providerLabel: 'Claude Code',
        accountLabel: 'work account',
        conductorEffort: 'medium',
      }).facts
    ).toEqual(['Claude Code', 'work account', 'conductor on medium effort']);
    expect(
      vitals({ providerLabel: 'Codex', accountLabel: '  ', conductorEffort: null }).facts
    ).toEqual(['Codex']);
    expect(vitals({ conductorEffort: 'high' }).facts).toEqual(['conductor on high effort']);
  });
});

describe('formatAge', () => {
  it('formats now, seconds, minutes, hours and days', () => {
    expect(formatAge(ago(0), NOW)).toBe('now');
    expect(formatAge(ago(4), NOW)).toBe('now');
    expect(formatAge(ago(32), NOW)).toBe('32s ago');
    expect(formatAge(ago(6 * 60 + 59), NOW)).toBe('6m ago');
    expect(formatAge(ago(2 * 3600 + 100), NOW)).toBe('2h ago');
    expect(formatAge(ago(3 * 86_400), NOW)).toBe('3d ago');
  });

  it('says now for a time in the future or one it cannot read', () => {
    expect(formatAge(ago(-60), NOW)).toBe('now');
    expect(formatAge('not a time', NOW)).toBe('now');
  });
});
