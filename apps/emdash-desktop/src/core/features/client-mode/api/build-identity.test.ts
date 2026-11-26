import { describe, expect, it } from 'vitest';
import { buildIdentitySchema, buildsCompatible, describeBuild } from './build-identity';

const build = (version: string, commit: string | null, dev = false) => ({ version, commit, dev });

describe('buildsCompatible', () => {
  it('compares commits when both builds know theirs', () => {
    expect(buildsCompatible(build('1.0.0', 'abc'), build('1.0.0', 'abc'))).toBe(true);
    expect(buildsCompatible(build('1.0.0', 'abc'), build('1.0.0', 'def'))).toBe(false);
    expect(buildsCompatible(build('1.0.0', 'abc'), build('1.0.1', 'abc'))).toBe(true);
  });

  it('falls back to versions when either commit is unknown', () => {
    expect(buildsCompatible(build('1.0.0', null), build('1.0.0', 'abc'))).toBe(true);
    expect(buildsCompatible(build('1.0.0', 'abc'), build('1.0.1', null))).toBe(false);
    expect(buildsCompatible(build('1.0.0', null, true), build('1.0.0', null))).toBe(true);
  });
});

describe('describeBuild', () => {
  it('names version, short commit and dev', () => {
    expect(describeBuild(build('1.4.2', '3f9c2ab9d0e1'))).toBe('1.4.2 (3f9c2ab)');
    expect(describeBuild(build('1.4.2', null, true))).toBe('1.4.2 dev');
  });
});

describe('buildIdentitySchema', () => {
  it('requires every field', () => {
    expect(
      buildIdentitySchema.safeParse({ version: '1.0.0', commit: null, dev: false }).success
    ).toBe(true);
    expect(buildIdentitySchema.safeParse({ version: '1.0.0' }).success).toBe(false);
  });
});
