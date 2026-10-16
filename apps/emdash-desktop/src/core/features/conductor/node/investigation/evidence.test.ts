import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkEvidence } from './evidence';

const RETRY_LINE = 'export function retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {';
const SECRET_LINE = 'API_TOKEN=canary-7f3a91';

let root: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'scout-evidence-'));
  project = path.join(root, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await mkdir(path.join(project, '.git'), { recursive: true });
  await mkdir(path.join(root, 'elsewhere'), { recursive: true });
  await writeFile(
    path.join(project, 'src', 'retry.ts'),
    `${RETRY_LINE}\n  return work().catch((error) => {\n    return retry(work, attempts - 1);\n  });\n}\n`
  );
  await writeFile(path.join(project, 'src', "it's.ts"), 'export const quoted = true;\n');
  await writeFile(path.join(project, '.env'), `${SECRET_LINE}\n`);
  await writeFile(path.join(project, '.git', 'config'), `[remote]\n  ${SECRET_LINE}\n`);
  await writeFile(path.join(project, 'big.txt'), `${RETRY_LINE}\n${'x'.repeat(2 * 1024 * 1024)}`);
  await writeFile(path.join(root, 'elsewhere', 'outside.ts'), `${RETRY_LINE}\n`);
  // Junctions need no privilege on Windows; elsewhere the type is ignored and this is a symlink.
  await symlink(path.join(root, 'elsewhere'), path.join(project, 'linked'), 'junction');
  await symlink(path.join(project, '.git'), path.join(project, 'history'), 'junction');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function found(item: { path: string; quote: string; line?: number }): Promise<boolean> {
  const [checked] = await checkEvidence(project, [item]);
  return checked?.found ?? false;
}

describe('checkEvidence', () => {
  it('finds a quote in the file it names and keeps the item as it was', async () => {
    const item = { path: 'src/retry.ts', line: 1, quote: RETRY_LINE };
    expect(await checkEvidence(project, [item])).toEqual([{ ...item, found: true }]);
  });

  it('ignores differences in white space', async () => {
    expect(
      await found({ path: 'src/retry.ts', quote: 'return   retry(work,\tattempts - 1);' })
    ).toBe(true);
    expect(
      await found({ path: 'src/retry.ts', quote: 'return work().catch((error) => { return retry(' })
    ).toBe(true);
  });

  it('does not find a quote the file does not hold', async () => {
    expect(await found({ path: 'src/retry.ts', quote: 'export function retryForever(' })).toBe(
      false
    );
    expect(await found({ path: 'src/missing.ts', quote: RETRY_LINE })).toBe(false);
    expect(await found({ path: 'src/retry.ts', quote: '   ' })).toBe(false);
  });

  it('accepts Windows separators and an absolute path inside the project', async () => {
    expect(await found({ path: 'src\\retry.ts', quote: RETRY_LINE })).toBe(true);
    expect(await found({ path: path.join(project, 'src', 'retry.ts'), quote: RETRY_LINE })).toBe(
      true
    );
  });

  it('accepts a path with an apostrophe in it', async () => {
    expect(await found({ path: "src/it's.ts", quote: 'export const quoted = true;' })).toBe(true);
  });

  it('refuses a path that leaves the project with ..', async () => {
    expect(await found({ path: '../elsewhere/outside.ts', quote: RETRY_LINE })).toBe(false);
    expect(await found({ path: 'src/../../elsewhere/outside.ts', quote: RETRY_LINE })).toBe(false);
  });

  it('refuses an absolute path outside the project', async () => {
    expect(
      await found({ path: path.join(root, 'elsewhere', 'outside.ts'), quote: RETRY_LINE })
    ).toBe(false);
  });

  it('refuses a link inside the project that points outside it', async () => {
    expect(await found({ path: 'linked/outside.ts', quote: RETRY_LINE })).toBe(false);
  });

  it('refuses a directory', async () => {
    expect(await found({ path: 'src', quote: RETRY_LINE })).toBe(false);
    expect(await found({ path: '.', quote: RETRY_LINE })).toBe(false);
  });

  it('refuses a denied file, by its own name and through a link', async () => {
    expect(await found({ path: '.env', quote: SECRET_LINE })).toBe(false);
    expect(await found({ path: '.git/config', quote: SECRET_LINE })).toBe(false);
    expect(await found({ path: 'history/config', quote: SECRET_LINE })).toBe(false);
  });

  it('refuses a file over the size limit', async () => {
    expect(await found({ path: 'big.txt', quote: RETRY_LINE })).toBe(false);
  });

  it('reports every item as not found when the folder is gone', async () => {
    expect(
      await checkEvidence(path.join(root, 'no-such-project'), [
        { path: 'src/retry.ts', quote: RETRY_LINE },
      ])
    ).toEqual([{ path: 'src/retry.ts', quote: RETRY_LINE, found: false }]);
  });
});

describe('checkEvidence with extra folders', () => {
  it('finds a quote in an extra folder and still refuses a denied file there', async () => {
    const notes = path.join(root, 'notes');
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, 'plan.md'), `${RETRY_LINE}\n`);
    await writeFile(path.join(notes, '.env'), `${SECRET_LINE}\n`);
    const items = [
      { path: path.join(notes, 'plan.md'), quote: RETRY_LINE },
      { path: path.join(notes, '.env'), quote: SECRET_LINE },
      { path: path.join(root, 'elsewhere', 'outside.ts'), quote: RETRY_LINE },
    ];
    const without = await checkEvidence(project, items);
    expect(without.map((item) => item.found)).toEqual([false, false, false]);
    const withNotes = await checkEvidence(project, items, [notes]);
    expect(withNotes.map((item) => item.found)).toEqual([true, false, false]);
  });
});
