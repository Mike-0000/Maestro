import { describe, expect, it } from 'vitest';
import {
  parseWslProbe,
  toWslArg,
  toWslPath,
  withWslEnv,
  wslHomeShare,
  wslProbeLine,
} from './wsl-launch';

describe('toWslPath', () => {
  it('maps a drive path to its mount', () => {
    expect(toWslPath('C:\\Github\\chorus')).toBe('/mnt/c/Github/chorus');
    expect(toWslPath('d:/work/app/')).toBe('/mnt/d/work/app');
    expect(toWslPath('C:\\')).toBe('/mnt/c');
    expect(toWslPath("C:\\Users\\'admin'\\AppData\\x.json")).toBe(
      "/mnt/c/Users/'admin'/AppData/x.json"
    );
  });

  it('maps a path on a distro share to the path inside the distro', () => {
    expect(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).toBe('/home/me/repo');
    expect(toWslPath('\\\\wsl$\\Ubuntu')).toBe('/');
  });

  it('leaves everything else alone', () => {
    for (const other of ['claude', '--model', '/usr/bin/claude', 'relative\\path', '\\\\nas\\x']) {
      expect(toWslPath(other), other).toBeNull();
    }
  });
});

describe('toWslArg', () => {
  it('translates a path argument and a path after a flag', () => {
    expect(toWslArg('C:\\data\\mcp.json')).toBe('/mnt/c/data/mcp.json');
    expect(toWslArg('--mcp-config=C:\\Users\\me\\AppData\\Roaming\\chorus\\a.json')).toBe(
      '--mcp-config=/mnt/c/Users/me/AppData/Roaming/chorus/a.json'
    );
  });

  it('translates the prompt file a long prompt was spilled to, and nothing else in it', () => {
    const prompt =
      'Read the file at C:\\Users\\me\\AppData\\Local\\Temp\\emdash-tui-prompt-abc\\task-context.md and complete the task. Keep C:\\notes.txt as it is.';
    expect(toWslArg(prompt)).toBe(
      'Read the file at /mnt/c/Users/me/AppData/Local/Temp/emdash-tui-prompt-abc/task-context.md and complete the task. Keep C:\\notes.txt as it is.'
    );
  });

  it('leaves flags, values and ordinary prompts alone', () => {
    for (const arg of ['--resume', 'abc-123', '--model=opus', 'fix the bug in C:\\x\\y.ts']) {
      expect(toWslArg(arg), arg).toBe(arg);
    }
  });
});

describe('withWslEnv', () => {
  it('names what the agent needs and none of what describes Windows', () => {
    const env = withWslEnv({
      PATH: 'C:\\Windows',
      HOME: 'C:\\Users\\me',
      USERPROFILE: 'C:\\Users\\me',
      SystemRoot: 'C:\\Windows',
      TERM: 'xterm-256color',
      EMDASH_HOOK_PORT: '5123',
      EMDASH_HOOK_NONCE: 'n',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    });
    expect(env.WSLENV.split(':').sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CONFIG_DIR/p',
        'EMDASH_HOOK_NONCE',
        'EMDASH_HOOK_PORT',
        'TERM',
      ].sort()
    );
    // The variables themselves are still there for wsl.exe to read.
    expect(env.EMDASH_HOOK_PORT).toBe('5123');
    expect(env.PATH).toBe('C:\\Windows');
  });

  it('keeps what the user already forwards, with their flags', () => {
    const env = withWslEnv({ WSLENV: 'MY_DIR/up:TERM/u', MY_DIR: 'C:\\x', TERM: 'xterm' });
    expect(env.WSLENV).toBe('MY_DIR/up:TERM/u');
  });
});

describe('the probe', () => {
  it('asks only for a plain CLI name', () => {
    expect(wslProbeLine('claude')).toContain('command -v claude');
    expect(() => wslProbeLine('claude; rm -rf ~')).toThrow();
  });

  it('reads the CLI, the distro and the home', () => {
    expect(parseWslProbe('/home/me/.local/bin/claude\nUbuntu-24.04\n/home/me\n')).toEqual({
      cli: '/home/me/.local/bin/claude',
      distro: 'Ubuntu-24.04',
      home: '/home/me',
    });
    // A login shell may print something first.
    expect(parseWslProbe('Welcome!\r\n/usr/bin/claude\r\nUbuntu\r\n/root\r\n')?.distro).toBe(
      'Ubuntu'
    );
  });

  it('refuses a distro that cannot run the agent', () => {
    // No CLI: `command -v` printed nothing and the line stopped there.
    expect(parseWslProbe('')).toBeNull();
    expect(parseWslProbe('Ubuntu\n/home/me\n')).toBeNull();
    // Docker Desktop's distro, and the Windows CLI seen through the drive mount.
    expect(parseWslProbe('/usr/bin/claude\ndocker-desktop\n/root\n')).toBeNull();
    expect(
      parseWslProbe('/mnt/c/Users/me/AppData/Roaming/npm/claude\nUbuntu\n/home/me\n')
    ).toBeNull();
    expect(parseWslProbe('/usr/bin/claude\nUbuntu; x\n/home/me\n')).toBeNull();
  });

  it('builds the share path of a file in the distro home', () => {
    expect(
      wslHomeShare({ cli: '/usr/bin/claude', distro: 'Ubuntu', home: '/home/me' }, '.claude')
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude');
  });
});
