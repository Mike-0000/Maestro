import { describe, expect, it } from 'vitest';
import { cleanTerminalOutput, hasReadableOutput } from './terminal-text';

describe('cleanTerminalOutput', () => {
  it('drops the padding at the end of every row', () => {
    expect(cleanTerminalOutput(`● Done.${' '.repeat(200)}\n  Next step.${' '.repeat(90)}`)).toBe(
      '● Done.\n  Next step.'
    );
  });

  it('drops rows drawn only of art or rules, and keeps words', () => {
    const screen = [
      '        ⣀⣾⣿⣿⠃ ⣀⣴⣾⣿⣿⡿⠟⠋',
      '      ⢸⣿⣿⡿⠛⠉⢀⣠⣴⣿⣿⣿⣷⣦⣀',
      '────────────────────',
      '› Ask Codex to do anything',
      '',
      '',
      '',
      '  GPT-6.1-Sol xhigh · F:\\Wearable Maestro Device',
    ].join('\n');
    expect(cleanTerminalOutput(screen)).toBe(
      '› Ask Codex to do anything\n\n  GPT-6.1-Sol xhigh · F:\\Wearable Maestro Device'
    );
  });

  it('tells an empty or art-only screen from one with words', () => {
    expect(hasReadableOutput(cleanTerminalOutput('⣀⣾⣿\n   \n────'))).toBe(false);
    expect(hasReadableOutput(cleanTerminalOutput('❯ \n  ⏵⏵ bypass permissions on'))).toBe(true);
  });
});
