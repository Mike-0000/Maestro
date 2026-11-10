import { describe, expect, it } from 'vitest';
import type { ClaudeAccountUsage, ClaudeUsageSnapshot } from '../api/types';
import {
  formatAsOf,
  formatResetsIn,
  formatUpdatedAgo,
  formatUsagePercent,
  headlineUsage,
  staleUsageNote,
  usagePlanLabel,
  usageRowView,
  usageSeverity,
} from './usage-model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Local time, so clock formatting does not depend on the machine's time zone.
const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function snapshot(overrides: Partial<ClaudeUsageSnapshot> = {}): ClaudeUsageSnapshot {
  return {
    fetchedAt: iso(-MINUTE),
    subscriptionType: 'max',
    fiveHour: { usedPercent: 12, resetsAt: iso(2 * HOUR + 5 * MINUTE) },
    sevenDay: { usedPercent: 46.4, resetsAt: iso(3 * DAY) },
    sevenDayOpus: null,
    sevenDaySonnet: null,
    limits: [],
    ...overrides,
  };
}

function usage(overrides: Partial<ClaudeAccountUsage> = {}): ClaudeAccountUsage {
  return { accountId: 'primary', status: 'fresh', snapshot: snapshot(), ...overrides };
}

describe('formatUsagePercent', () => {
  it('rounds and clamps', () => {
    expect(formatUsagePercent(46.4)).toBe('46%');
    expect(formatUsagePercent(99.6)).toBe('100%');
    expect(formatUsagePercent(140)).toBe('100%');
    expect(formatUsagePercent(-3)).toBe('0%');
    expect(formatUsagePercent(Number.NaN)).toBe('0%');
  });

  it('never shows some usage as none', () => {
    expect(formatUsagePercent(0)).toBe('0%');
    expect(formatUsagePercent(0.2)).toBe('1%');
  });
});

describe('usageSeverity', () => {
  it('stays calm until usage is high', () => {
    expect(usageSeverity(0)).toBe('calm');
    expect(usageSeverity(74.9)).toBe('calm');
    expect(usageSeverity(75)).toBe('warning');
    expect(usageSeverity(89.9)).toBe('warning');
    expect(usageSeverity(90)).toBe('critical');
    expect(usageSeverity(100)).toBe('critical');
  });

  it('is raised, never lowered, by what the service reports', () => {
    expect(usageSeverity(20, 'warning')).toBe('warning');
    expect(usageSeverity(20, 'critical')).toBe('critical');
    expect(usageSeverity(95, 'normal')).toBe('critical');
    expect(usageSeverity(80, 'normal')).toBe('warning');
    expect(usageSeverity(20, 'normal')).toBe('calm');
    expect(usageSeverity(20, null)).toBe('calm');
  });
});

describe('formatResetsIn', () => {
  it('uses the largest fitting unit', () => {
    expect(formatResetsIn(iso(3 * DAY), NOW)).toBe('resets in 3 days');
    expect(formatResetsIn(iso(DAY + 2 * HOUR), NOW)).toBe('resets in 1 day');
    expect(formatResetsIn(iso(5 * HOUR + 59 * MINUTE), NOW)).toBe('resets in 5 hr');
    expect(formatResetsIn(iso(12 * MINUTE + 30_000), NOW)).toBe('resets in 12 min');
  });

  it('says now when the reset is due or past', () => {
    expect(formatResetsIn(iso(20_000), NOW)).toBe('resets now');
    expect(formatResetsIn(iso(-HOUR), NOW)).toBe('resets now');
  });

  it('is null without a usable reset time', () => {
    expect(formatResetsIn(null, NOW)).toBeNull();
    expect(formatResetsIn('not a date', NOW)).toBeNull();
  });
});

describe('formatAsOf', () => {
  it('shows the time for today and the date for another day', () => {
    expect(formatAsOf(new Date(2026, 10, 10, 14, 14).toISOString(), NOW, 'en-US')).toBe('2:14 PM');
    expect(formatAsOf(new Date(2026, 10, 3, 9, 5).toISOString(), NOW, 'en-US')).toBe(
      'Nov 3, 9:05 AM'
    );
  });

  it('degrades when the time is unreadable', () => {
    expect(formatAsOf('nope', NOW, 'en-US')).toBe('earlier');
  });
});

describe('formatUpdatedAgo', () => {
  it('reads as a short phrase', () => {
    expect(formatUpdatedAgo(null, NOW)).toBeNull();
    expect(formatUpdatedAgo(NOW - 5_000, NOW)).toBe('Updated just now');
    expect(formatUpdatedAgo(NOW + 5_000, NOW)).toBe('Updated just now');
    expect(formatUpdatedAgo(NOW - 4 * MINUTE, NOW)).toBe('Updated 4 min ago');
    expect(formatUpdatedAgo(NOW - 2 * HOUR, NOW)).toBe('Updated 2 hr ago');
  });
});

describe('usageRowView', () => {
  it('is loading until an answer arrives', () => {
    expect(usageRowView(undefined, NOW)).toEqual({ kind: 'loading' });
  });

  it('shows the weekly window first, then the 5-hour one', () => {
    const view = usageRowView(usage(), NOW);
    expect(view).toMatchObject({
      kind: 'meters',
      stale: null,
      models: [],
      meters: [
        {
          key: 'weekly',
          label: 'Weekly',
          percentLabel: '46%',
          severity: 'calm',
          resets: 'resets in 3 days',
        },
        {
          key: 'five-hour',
          label: '5-hour',
          percentLabel: '12%',
          severity: 'calm',
          resets: 'resets in 2 hr',
        },
      ],
    });
  });

  it('leaves out the 5-hour window when the plan has none', () => {
    const view = usageRowView(usage({ snapshot: snapshot({ fiveHour: null }) }), NOW);
    expect(view.kind === 'meters' && view.meters.map((meter) => meter.key)).toEqual(['weekly']);
  });

  it('lists per-model weekly windows when present', () => {
    const view = usageRowView(
      usage({
        snapshot: snapshot({
          sevenDayOpus: { usedPercent: 31, resetsAt: null },
          sevenDaySonnet: { usedPercent: 92, resetsAt: null },
        }),
      }),
      NOW
    );
    expect(view.kind === 'meters' && view.models).toEqual([
      { label: 'Opus', percentLabel: '31%', severity: 'calm' },
      { label: 'Sonnet', percentLabel: '92%', severity: 'critical' },
    ]);
  });

  it('takes the weekly severity the service reports into account', () => {
    const view = usageRowView(
      usage({
        snapshot: snapshot({
          limits: [
            {
              kind: 'weekly_all',
              group: 'weekly',
              scope: null,
              usedPercent: 46,
              resetsAt: null,
              severity: 'warning',
            },
          ],
        }),
      }),
      NOW
    );
    expect(view.kind === 'meters' && view.meters[0]?.severity).toBe('warning');
  });

  it('marks old numbers with when they are from and why', () => {
    const view = usageRowView(
      usage({
        status: 'stale',
        reason: 'token-expired',
        snapshot: snapshot({ fetchedAt: new Date(2026, 10, 10, 14, 14).toISOString() }),
      }),
      NOW,
      'en-US'
    );
    expect(view).toMatchObject({
      kind: 'meters',
      stale: {
        asOf: '2:14 PM',
        note: 'Updates the next time an agent runs on this account.',
        action: null,
      },
    });
  });

  it('offers sign-in beside old numbers when Claude rejected the sign-in', () => {
    const view = usageRowView(usage({ status: 'stale', reason: 'unauthorized' }), NOW);
    expect(view.kind === 'meters' && view.stale?.action).toBe('sign-in');
  });

  it('offers sign-in when the account has none', () => {
    expect(
      usageRowView(usage({ status: 'unavailable', snapshot: null, reason: 'not-logged-in' }), NOW)
    ).toEqual({ kind: 'unavailable', message: 'Not signed in.', action: 'sign-in' });
    expect(
      usageRowView(usage({ status: 'unavailable', snapshot: null, reason: 'unauthorized' }), NOW)
    ).toMatchObject({ kind: 'unavailable', action: 'sign-in' });
  });

  it('explains every other reason usage is missing, without an action', () => {
    const reasons = ['token-expired', 'rate-limited', 'network', 'unexpected-response'] as const;
    const messages = reasons.map((reason) => {
      const view = usageRowView(usage({ status: 'unavailable', snapshot: null, reason }), NOW);
      expect(view).toMatchObject({ kind: 'unavailable', action: null });
      return view.kind === 'unavailable' ? view.message : '';
    });
    expect(new Set(messages).size).toBe(reasons.length);
    expect(
      usageRowView(usage({ status: 'unavailable', snapshot: null, reason: undefined }), NOW)
    ).toEqual({ kind: 'unavailable', message: "Couldn't load usage.", action: null });
  });

  it('says so when a plan reports no windows at all', () => {
    expect(
      usageRowView(usage({ snapshot: snapshot({ fiveHour: null, sevenDay: null }) }), NOW)
    ).toEqual({
      kind: 'unavailable',
      message: 'This plan reports no usage limits.',
      action: null,
    });
  });
});

describe('staleUsageNote', () => {
  it('has a sentence for every reason', () => {
    const reasons = [
      'token-expired',
      'unauthorized',
      'rate-limited',
      'network',
      'unexpected-response',
      undefined,
    ] as const;
    for (const reason of reasons) expect(staleUsageNote(reason)).toMatch(/\.$/);
  });
});

describe('usagePlanLabel', () => {
  it('prefers the plan the usage answer names', () => {
    expect(usagePlanLabel(usage(), { plan: 'pro' })).toBe('Max');
  });

  it('falls back to the last known identity', () => {
    expect(usagePlanLabel(undefined, { plan: 'pro' })).toBe('Pro');
    expect(
      usagePlanLabel(usage({ snapshot: snapshot({ subscriptionType: null }) }), {})
    ).toBeNull();
  });
});

describe('headlineUsage', () => {
  it('is the weekly window when there is one', () => {
    expect(headlineUsage(usage())).toEqual({
      label: 'weekly',
      percentLabel: '46%',
      severity: 'calm',
    });
  });

  it('falls back to the 5-hour window', () => {
    expect(
      headlineUsage(
        usage({
          snapshot: snapshot({ sevenDay: null, fiveHour: { usedPercent: 91, resetsAt: null } }),
        })
      )
    ).toEqual({ label: '5-hour', percentLabel: '91%', severity: 'critical' });
  });

  it('is null without numbers', () => {
    expect(headlineUsage(undefined)).toBeNull();
    expect(headlineUsage(usage({ status: 'unavailable', snapshot: null }))).toBeNull();
    expect(
      headlineUsage(usage({ snapshot: snapshot({ sevenDay: null, fiveHour: null }) }))
    ).toBeNull();
  });
});
