import { describe, expect, it } from 'vitest';
import {
  claudeRulePath,
  isScoutDenied,
  SCOUT_DENY,
  scoutDenyRules,
  scoutSettingsContent,
} from './scout-deny';

describe('the scout deny list', () => {
  it('denies secret files at the root and at any depth', () => {
    for (const path of [
      '.env',
      '.env.local',
      'apps/api/.env.production',
      '.envrc',
      'certs/server.pem',
      'deploy/tls.key',
      'store.p12',
      'store.pfx',
      'android/release.jks',
      'putty.ppk',
      'id_rsa',
      'keys/id_rsa.pub',
      'id_ed25519',
      'id_ecdsa_work',
      '.npmrc',
      'packages/ui/.npmrc',
      '.pypirc',
      '.netrc',
      '.git-credentials',
      'infra/prod.tfvars',
      'infra/terraform.tfstate',
      'infra/terraform.tfstate.backup',
    ]) {
      expect(isScoutDenied(path), path).toBe(true);
    }
  });

  it('denies everything under the credential directories', () => {
    for (const path of [
      '.git/config',
      'vendor/lib/.git/HEAD',
      '.ssh/known_hosts',
      '.aws/credentials',
      '.kube/config',
      '.docker/config.json',
    ]) {
      expect(isScoutDenied(path), path).toBe(true);
    }
  });

  it('leaves ordinary source files alone', () => {
    for (const path of [
      'src/index.ts',
      'src/env.ts',
      'docs/environment.md',
      'src/keys/keyboard.ts',
      'config/git.ts',
      '.github/workflows/ci.yml',
      '.gitignore',
      'src/pem-parser.ts',
      'README.md',
    ]) {
      expect(isScoutDenied(path), path).toBe(false);
    }
  });

  it('accepts either separator and a leading dot segment', () => {
    expect(isScoutDenied('apps\\api\\.env')).toBe(true);
    expect(isScoutDenied('.\\.git\\config')).toBe(true);
    expect(isScoutDenied('./src/index.ts')).toBe(false);
  });

  it('folds case where the file system does', () => {
    expect(isScoutDenied('.ENV', 'win32')).toBe(true);
    expect(isScoutDenied('Certs/Server.PEM', 'darwin')).toBe(true);
    expect(isScoutDenied('.GIT/config', 'win32')).toBe(true);
    expect(isScoutDenied('.ENV', 'linux')).toBe(false);
    expect(isScoutDenied('.env', 'linux')).toBe(true);
  });

  it('hides what is under a directory that carries a denied name', () => {
    expect(isScoutDenied('backup.key/notes.md')).toBe(true);
  });

  it('writes one rule per pattern for the root and one for any depth', () => {
    const rules = scoutDenyRules();
    expect(rules).toHaveLength(2 * (SCOUT_DENY.files.length + SCOUT_DENY.directories.length));
    expect(rules).toContain('Read(./.env)');
    expect(rules).toContain('Read(**/.env)');
    expect(rules).toContain('Read(./*.pem)');
    expect(rules).toContain('Read(**/terraform.tfstate*)');
    expect(rules).toContain('Read(./.git/**)');
    expect(rules).toContain('Read(**/.ssh/**)');
    expect(rules.every((rule) => /^Read\((?:\.\/|\*\*\/)[^()]+\)$/.test(rule))).toBe(true);
  });

  it('makes a settings file that holds the deny list and nothing else', () => {
    expect(JSON.parse(scoutSettingsContent())).toEqual({ permissions: { deny: scoutDenyRules() } });
  });
});

describe('extra folders', () => {
  it('writes an absolute folder the way permission rules name it', () => {
    expect(claudeRulePath('/home/dev/notes', 'linux')).toBe('//home/dev/notes');
    expect(claudeRulePath('/home/dev/notes/', 'darwin')).toBe('//home/dev/notes');
    expect(claudeRulePath('C:\\Users\\dev\\notes', 'win32')).toBe('//c/Users/dev/notes');
    expect(claudeRulePath('D:/work/', 'win32')).toBe('//d/work');
  });

  it('anchors every deny pattern at each extra folder as well', () => {
    const base = scoutDenyRules();
    const rules = scoutDenyRules(['/home/dev/notes'], 'linux');
    expect(rules.slice(0, base.length)).toEqual(base);
    expect(rules).toContain('Read(//home/dev/notes/.env)');
    expect(rules).toContain('Read(//home/dev/notes/**/.env)');
    expect(rules).toContain('Read(//home/dev/notes/**/.ssh/**)');
    expect(rules).toHaveLength(base.length * 2);
  });

  it('lists the folders as additional directories in the settings file', () => {
    expect(JSON.parse(scoutSettingsContent(['/home/dev/notes'], 'linux'))).toEqual({
      permissions: {
        deny: scoutDenyRules(['/home/dev/notes'], 'linux'),
        additionalDirectories: ['/home/dev/notes'],
      },
    });
  });
});
