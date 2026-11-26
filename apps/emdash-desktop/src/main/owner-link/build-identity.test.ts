import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildsCompatible } from '@core/features/client-mode/api/build-identity';
import { isBuildCheckSkipped, resolveBuildIdentity } from './build-identity';

const resources = join('C:', 'Program Files', 'Maestro', 'resources');

function reader(files: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path: string) => {
      reads.push(path);
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    },
  };
}

describe('resolveBuildIdentity', () => {
  it('takes the commit from build-provenance.json in a packaged build', async () => {
    const files = reader({
      [join(resources, 'build-provenance.json')]: JSON.stringify({
        buildId: 'b-1',
        commit: '3f9c2ab0d1e2',
        version: '1.4.2',
      }),
    });
    await expect(
      resolveBuildIdentity({
        isPackaged: true,
        version: '1.4.2',
        resourcesPath: resources,
        readFile: files.readFile,
      })
    ).resolves.toEqual({ version: '1.4.2', commit: '3f9c2ab0d1e2', dev: false });
    expect(files.reads).toEqual([join(resources, 'build-provenance.json')]);
  });

  it('has no commit when the packaged build has no readable provenance', async () => {
    for (const files of [
      reader({}),
      reader({ [join(resources, 'build-provenance.json')]: 'not json' }),
      reader({ [join(resources, 'build-provenance.json')]: JSON.stringify({ commit: '  ' }) }),
      reader({ [join(resources, 'build-provenance.json')]: 'null' }),
    ]) {
      await expect(
        resolveBuildIdentity({
          isPackaged: true,
          version: '1.4.2',
          resourcesPath: resources,
          readFile: files.readFile,
        })
      ).resolves.toEqual({ version: '1.4.2', commit: null, dev: false });
    }
  });

  it('marks an unpackaged run as dev without reading any file', async () => {
    const files = reader({});
    await expect(
      resolveBuildIdentity({
        isPackaged: false,
        version: '1.4.2',
        resourcesPath: resources,
        readFile: files.readFile,
      })
    ).resolves.toEqual({ version: '1.4.2', commit: null, dev: true });
    expect(files.reads).toEqual([]);
  });

  it('produces identities the handshake can compare', async () => {
    const provenance = (commit: string) =>
      reader({ [join(resources, 'build-provenance.json')]: JSON.stringify({ commit }) }).readFile;
    const source = { isPackaged: true, version: '1.4.2', resourcesPath: resources };
    const host = await resolveBuildIdentity({ ...source, readFile: provenance('aaa') });
    const same = await resolveBuildIdentity({ ...source, readFile: provenance('aaa') });
    const other = await resolveBuildIdentity({ ...source, readFile: provenance('bbb') });
    expect(buildsCompatible(host, same)).toBe(true);
    expect(buildsCompatible(host, other)).toBe(false);
  });
});

describe('isBuildCheckSkipped', () => {
  it('honours the variable only in an unpackaged run', () => {
    expect(isBuildCheckSkipped(false, { MAESTRO_SKIP_BUILD_CHECK: '1' })).toBe(true);
    expect(isBuildCheckSkipped(true, { MAESTRO_SKIP_BUILD_CHECK: '1' })).toBe(false);
    expect(isBuildCheckSkipped(false, {})).toBe(false);
    expect(isBuildCheckSkipped(false, { MAESTRO_SKIP_BUILD_CHECK: 'true' })).toBe(false);
  });
});
