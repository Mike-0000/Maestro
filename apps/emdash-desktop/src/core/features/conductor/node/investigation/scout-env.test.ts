import { describe, expect, it } from 'vitest';
import { scoutEnv } from './scout-env';

/** An app environment as it looks inside a Maestro agent tile, plus other providers' keys. */
const APP_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  USER: 'dev',
  LANG: 'en_US.UTF-8',
  TZ: 'Europe/Berlin',
  TMPDIR: '/tmp/dev',
  XDG_CONFIG_HOME: '/home/dev/.config',
  HTTPS_PROXY: 'http://proxy.example:8080',
  NO_PROXY: 'localhost',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ANTHROPIC_BASE_URL: 'https://gateway.example',
  CLAUDE_CONFIG_DIR: '/home/dev/.claude-work',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  AWS_PROFILE: 'work',
  AWS_REGION: 'eu-central-1',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/dev/gcp.json',
  GOOGLE_CLOUD_PROJECT: 'acme',
  GOOGLE_CLOUD_LOCATION: 'europe-west4',
  // Everything below must not reach a scout.
  EMDASH_HOOK_PORT: '49152',
  EMDASH_HOOK_NONCE: 'nonce',
  EMDASH_PTY_ID: 'pty-1',
  EMDASH_DB_FILE: '/tmp/emdash.db',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ID: 'session-1',
  CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
  GH_TOKEN: 'ghp_test',
  GITHUB_TOKEN: 'ghp_test',
  OPENAI_API_KEY: 'sk-test',
  OPENROUTER_API_KEY: 'sk-or-test',
  GEMINI_API_KEY: 'gemini-test',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  EDITOR: 'vim',
  DISPLAY: ':0',
  NODE_OPTIONS: '--inspect',
  ELECTRON_RUN_AS_NODE: '1',
  npm_config_registry: 'https://registry.example',
};

describe('scoutEnv', () => {
  it('drops Maestro, session, and other-provider variables', () => {
    const env = scoutEnv(APP_ENV, {}, 'posix');
    expect(Object.keys(env).filter((name) => name.startsWith('EMDASH_'))).toEqual([]);
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY',
      'SSH_AUTH_SOCK',
      'EDITOR',
      'DISPLAY',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'npm_config_registry',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('keeps what Claude Code needs to start, reach the network, and sign in', () => {
    expect(scoutEnv(APP_ENV, {}, 'posix')).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'emdash',
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev',
      USER: 'dev',
      LANG: 'en_US.UTF-8',
      TZ: 'Europe/Berlin',
      TMPDIR: '/tmp/dev',
      XDG_CONFIG_HOME: '/home/dev/.config',
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      CLAUDE_CONFIG_DIR: '/home/dev/.claude-work',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      AWS_PROFILE: 'work',
      AWS_REGION: 'eu-central-1',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/dev/gcp.json',
      GOOGLE_CLOUD_PROJECT: 'acme',
      GOOGLE_CLOUD_LOCATION: 'europe-west4',
    });
  });

  it('keeps the Windows basics, whatever their spelling', () => {
    const env = scoutEnv(
      {
        Path: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\dev',
        USERNAME: 'dev',
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        TEMP: 'C:\\Temp',
        TMP: 'C:\\Temp',
        SystemRoot: 'C:\\Windows',
        SYSTEMDRIVE: 'C:',
        ProgramData: 'C:\\ProgramData',
        ALLUSERSPROFILE: 'C:\\ProgramData',
        windir: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.CMD',
        EMDASH_HOOK_PORT: '49152',
        OPENAI_API_KEY: 'sk-test',
      },
      {},
      'windows'
    );
    expect(env).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'emdash',
      PATH: 'C:\\Windows\\System32',
      HOME: 'C:\\Users\\dev',
      USER: 'dev',
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      ProgramData: 'C:\\ProgramData',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.CMD',
    });
  });

  it("applies the user's Claude Code environment last and whole", () => {
    const env = scoutEnv(
      APP_ENV,
      { ANTHROPIC_BASE_URL: 'https://corp.example', MY_GATEWAY_TOKEN: 'abc' },
      'posix'
    );
    expect(env.ANTHROPIC_BASE_URL).toBe('https://corp.example');
    expect(env.MY_GATEWAY_TOKEN).toBe('abc');
    expect(env).not.toHaveProperty('EMDASH_HOOK_PORT');
  });
});
