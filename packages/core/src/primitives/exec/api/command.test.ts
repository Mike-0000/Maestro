import { describe, expect, it } from 'vitest';
import { formatCommandLine, quoteArg } from './command';

describe('quoteArg', () => {
  it('quotes POSIX shell arguments', () => {
    expect(quoteArg('', 'posix')).toBe("''");
    expect(quoteArg('/home/user/project', 'posix')).toBe('/home/user/project');
    expect(quoteArg('/home/user/file name', 'posix')).toBe("'/home/user/file name'");
    expect(quoteArg('# comment', 'posix')).toBe("'# comment'");
    expect(quoteArg("a'; rm -rf /; echo '", 'posix')).toBe("'a'\\''; rm -rf /; echo '\\'''");
  });

  it('uses POSIX quoting for WSL arguments', () => {
    expect(quoteArg('$HOME/*.txt', 'wsl')).toBe("'$HOME/*.txt'");
  });

  it('escapes csh history expansion', () => {
    expect(quoteArg('hello!', 'csh')).toBe("'hello\\!'");
  });

  it('quotes cmd.exe arguments', () => {
    expect(quoteArg('', 'windows-cmd')).toBe('""');
    expect(quoteArg('plain', 'windows-cmd')).toBe('plain');
    expect(quoteArg('a b&%x!', 'windows-cmd')).toBe('"a b&%%cd:~,%x!"');
  });

  it('keeps cmd.exe metacharacters literal inside the quotes', () => {
    expect(quoteArg('(1) a ^ b | c < d > e', 'windows-cmd')).toBe('"(1) a ^ b | c < d > e"');
  });

  it('doubles embedded quotes so cmd quote state stays balanced', () => {
    expect(quoteArg('x" & echo injected & "', 'windows-cmd')).toBe('"x"" & echo injected & """');
  });

  it('doubles backslashes only before a quote or the closing quote', () => {
    expect(quoteArg('C:\\dir name\\', 'windows-cmd')).toBe('"C:\\dir name\\\\"');
    expect(quoteArg('a\\"b', 'windows-cmd')).toBe('"a\\\\""b"');
    expect(quoteArg('C:\\a b\\c', 'windows-cmd')).toBe('"C:\\a b\\c"');
  });

  it('keeps percent signs from expanding variables', () => {
    expect(quoteArg('%PATH% 100%', 'windows-cmd')).toBe('"%%cd:~,%PATH%%cd:~,% 100%%cd:~,%"');
  });

  it('flattens line breaks, which would end a cmd.exe command', () => {
    expect(quoteArg('line 1\r\nline 2\nline 3', 'windows-cmd')).toBe('"line 1 line 2 line 3"');
  });

  it('quotes PowerShell arguments', () => {
    expect(quoteArg('', 'powershell')).toBe("''");
    expect(quoteArg('plain', 'powershell')).toBe('plain');
    expect(quoteArg("a b'c", 'powershell')).toBe("'a b''c'");
  });
});

describe('formatCommandLine', () => {
  it('formats a command and its arguments for the requested shell', () => {
    expect(
      formatCommandLine(
        {
          command: '/opt/Emdash Server/bin/emdash',
          args: ['start', '--socket', '/tmp/emdash socket'],
        },
        'posix'
      )
    ).toBe("'/opt/Emdash Server/bin/emdash' start --socket '/tmp/emdash socket'");
  });

  it('uses the PowerShell invocation operator', () => {
    expect(
      formatCommandLine(
        {
          command: 'C:\\Program Files\\Emdash\\emdash.exe',
          args: ['start', '--name', "David's task"],
        },
        'powershell'
      )
    ).toBe("& 'C:\\Program Files\\Emdash\\emdash.exe' start --name 'David''s task'");
  });
});
