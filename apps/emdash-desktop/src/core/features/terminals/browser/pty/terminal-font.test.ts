import { describe, expect, it } from 'vitest';
import {
  buildTerminalFontFamily,
  defaultTerminalFontName,
} from '@core/features/terminals/api/browser/pty/terminal-font';

describe('buildTerminalFontFamily', () => {
  it('quotes font family names that contain spaces', () => {
    expect(buildTerminalFontFamily('SF Mono')).toBe(
      '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
    );
  });

  it('escapes quotes in custom font names', () => {
    expect(buildTerminalFontFamily('Font "Name"')).toBe(
      '"Font \\"Name\\"", "Menlo", "Monaco", "Consolas", monospace'
    );
  });

  it('preserves comma-separated custom font family lists', () => {
    expect(buildTerminalFontFamily('SF Mono, Menlo, Monaco')).toBe(
      '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
    );
  });

  it('does not treat quoted CSS lists as a single quoted font name', () => {
    expect(buildTerminalFontFamily('"SF Mono", "Menlo"')).toBe(
      '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
    );
  });

  it('keeps generic font families unquoted', () => {
    expect(buildTerminalFontFamily('monospace')).toBe('monospace, "Menlo", "Monaco", "Consolas"');
  });

  it('uses terminal-safe fallbacks when no custom font is set', () => {
    expect(buildTerminalFontFamily()).toBe('"Menlo", "Monaco", "Consolas", monospace');
  });
});

describe('defaultTerminalFontName', () => {
  it('names the font the default chain resolves to on each platform', () => {
    expect(defaultTerminalFontName('mac')).toBe('Menlo');
    expect(defaultTerminalFontName('windows')).toBe('Consolas');
    expect(defaultTerminalFontName('linux')).toBe('System monospace');
  });
});
