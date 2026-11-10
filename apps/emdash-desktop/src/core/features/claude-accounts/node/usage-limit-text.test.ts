import { describe, expect, it } from 'vitest';
import { usageLimitLineInReply, usageLimitLineInTerminal } from './usage-limit-text';

describe('usageLimitLineInReply', () => {
  it('finds the CLI limit message at the end of a reply', () => {
    expect(usageLimitLineInReply("You've hit your limit · resets 5pm (Europe/Berlin)")).toBe(
      "You've hit your limit · resets 5pm (Europe/Berlin)"
    );
    expect(
      usageLimitLineInReply(
        "Let me run the tests.\n\nYou've reached your weekly limit · resets Mon 9am\n/upgrade to keep going"
      )
    ).toBe("You've reached your weekly limit · resets Mon 9am");
    expect(usageLimitLineInReply('You’ve hit your limit')).toBe("You've hit your limit");
  });

  it('ignores ordinary replies, warnings, transient errors and earlier mentions', () => {
    expect(usageLimitLineInReply('Done. All tests pass.')).toBeNull();
    expect(usageLimitLineInReply("You've used 90% of your weekly limit")).toBeNull();
    expect(usageLimitLineInReply("You're now using extra usage")).toBeNull();
    expect(usageLimitLineInReply('API Error: 429 rate_limit_error · Retrying in 5s')).toBeNull();
    expect(usageLimitLineInReply('API Error: 529 Overloaded')).toBeNull();
    expect(
      usageLimitLineInReply(
        "You've hit your limit earlier.\nThen it reset.\nNow I continued.\nAll done here."
      )
    ).toBeNull();
    expect(usageLimitLineInReply('The CLI prints "You\'ve hit your limit" when out')).toBeNull();
    expect(usageLimitLineInReply(undefined)).toBeNull();
  });
});

describe('usageLimitLineInTerminal', () => {
  it('finds the message among escape sequences and decoration', () => {
    const raw =
      '\u001b[2K\u001b[1A\u001b[2K\u001b[G\u001b[38;5;246m⎿ \u001b[39m \u001b[31mYou’ve hit your limit · resets 3am\u001b[39m' +
      '\u001b[1B\u001b[G╭────────╮\r\n│ > \u001b[7m \u001b[27m │\r\n╰────────╯\r\n  ? for shortcuts';
    expect(usageLimitLineInTerminal(raw)).toBe("You've hit your limit · resets 3am");
  });

  it('treats cursor movement as a line break, so redrawn lines do not run together', () => {
    const raw = "Working…\u001b[1A\u001b[2KYou've hit your limit · resets 3am\u001b[1B";
    expect(usageLimitLineInTerminal(raw)).toBe("You've hit your limit · resets 3am");
  });

  it('only looks at the end of the output', () => {
    const old = "You've hit your limit · resets 3am\r\n";
    const later = Array.from({ length: 60 }, (_, index) => `line ${index}\r\n`).join('');
    expect(usageLimitLineInTerminal(old + later)).toBeNull();
    expect(usageLimitLineInTerminal('● All tests pass.\r\n> ')).toBeNull();
    expect(usageLimitLineInTerminal(null)).toBeNull();
  });
});
