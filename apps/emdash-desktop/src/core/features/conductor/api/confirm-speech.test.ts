import { describe, expect, it } from 'vitest';
import { spokenConfirmation, spokenPreview } from './confirm-speech';

describe('spokenConfirmation', () => {
  it('says the action, whom it is for, and the first words of what it carries', () => {
    expect(
      spokenConfirmation('Send to Zulu: “run the tests again and then report what failed”')
    ).toBe('Send to Zulu "run the tests again and then report…"? Say yes.');
    expect(spokenConfirmation('Send to Quartz: “Yes, I can proceed”')).toBe(
      'Send to Quartz "Yes, I can proceed"? Say yes.'
    );
    expect(
      spokenConfirmation(
        'Start Codex in Chorus on “Fix login” · a 1,200-character prompt',
        'Fix the login redirect loop on the settings page and add a test.'
      )
    ).toBe('Start Codex in Chorus on Fix login "Fix the login redirect loop…"? Say yes.');
    expect(spokenConfirmation('Interrupt Atlas')).toBe('Interrupt Atlas? Say yes.');
  });

  it('never stops the preview on a word that leads into what was left out', () => {
    expect(spokenPreview('check the logs and the build output and then report')).toBe(
      'check the logs and the build output…'
    );
    expect(spokenPreview('one two three four five six and seven eight nine')).toBe(
      'one two three four five six…'
    );
  });

  it('cuts a long action between words', () => {
    const label = `Start Claude on ${'a long task name '.repeat(8)}`.trim();
    const action = spokenConfirmation(label).replace(/\? Say yes\.$/, '');
    expect(action.length).toBeLessThanOrEqual(80);
    // Whole words only: what is said is the label up to a space.
    expect(label.startsWith(`${action} `)).toBe(true);
  });
});
