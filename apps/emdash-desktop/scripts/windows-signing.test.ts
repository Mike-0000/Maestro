import { describe, expect, it } from 'vitest';
import { resolveWindowsSigntoolOptions, WINDOWS_SIGNING_ENV } from './windows-signing';

const THUMBPRINT = 'CB502803A15C2DAAE62EDD5869E318A0F607329A';
const LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';
const missing = () => {
  throw new Error('ENOENT');
};

describe('resolveWindowsSigntoolOptions', () => {
  it('builds unsigned when no identity is configured', () => {
    expect(resolveWindowsSigntoolOptions({ LOCALAPPDATA }, 'win32', missing)).toBeUndefined();
  });

  it('signs with the store certificate named by the local signing file', () => {
    const files: string[] = [];
    const options = resolveWindowsSigntoolOptions({ LOCALAPPDATA }, 'win32', (path) => {
      files.push(path);
      return `\uFEFF{"certificateSha1":"${THUMBPRINT.toLowerCase()}"}`;
    });
    expect(options).toEqual({ certificateSha1: THUMBPRINT, signingHashAlgorithms: ['sha256'] });
    expect(files).toEqual([`${LOCALAPPDATA}\\Chorus\\Signing\\windows-signing.json`]);
  });

  it('lets the environment override or disable the local file', () => {
    const file = () => `{"certificateSha1":"${'A'.repeat(40)}"}`;
    expect(
      resolveWindowsSigntoolOptions(
        { LOCALAPPDATA, [WINDOWS_SIGNING_ENV]: THUMBPRINT },
        'win32',
        file
      )?.certificateSha1
    ).toBe(THUMBPRINT);
    expect(
      resolveWindowsSigntoolOptions({ LOCALAPPDATA, [WINDOWS_SIGNING_ENV]: 'off' }, 'win32', file)
    ).toBeUndefined();
  });

  it('never signs off Windows and rejects malformed identities', () => {
    expect(
      resolveWindowsSigntoolOptions({ [WINDOWS_SIGNING_ENV]: THUMBPRINT }, 'linux', missing)
    ).toBeUndefined();
    expect(() =>
      resolveWindowsSigntoolOptions({ [WINDOWS_SIGNING_ENV]: 'not-a-thumbprint' }, 'win32', missing)
    ).toThrow(/SHA-1/);
    expect(() =>
      resolveWindowsSigntoolOptions({ LOCALAPPDATA }, 'win32', () => '{"thumbprint":"x"}')
    ).toThrow(/certificateSha1/);
  });
});
