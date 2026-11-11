import { describe, expect, it } from 'vitest';
import { describeCron } from './cron-utils';

describe('describeCron', () => {
  it('reads each supported period as a short sentence', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
    expect(describeCron('5 * * * *')).toBe('Every hour at :05');
    expect(describeCron('0 9 * * *')).toBe('Every day at 09:00');
    expect(describeCron('30 10 * * 1')).toBe('Every Monday at 10:30');
    expect(describeCron('0 9 1 * *')).toBe('Every month on the 1st at 09:00');
    expect(describeCron('0 14 22 3 *')).toBe('Every year on March 22nd at 14:00');
  });

  it('returns null outside the subset the picker understands', () => {
    expect(describeCron('0 9 * * 1-5')).toBeNull();
    expect(describeCron('nonsense')).toBeNull();
  });
});
