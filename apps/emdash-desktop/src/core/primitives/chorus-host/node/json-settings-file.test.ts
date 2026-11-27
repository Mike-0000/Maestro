import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonSettingsFile } from './json-settings-file';

const schema = z.object({
  provider: z.enum(['anthropic', 'openrouter']),
  jevSource: z.enum(['auto', 'openrouter', 'typesafe']),
  days: z.number().int().min(1),
});
type Settings = z.infer<typeof schema>;
const defaults: Settings = { provider: 'anthropic', jevSource: 'auto', days: 7 };

describe('JsonSettingsFile', () => {
  let dir: string;
  let file: JsonSettingsFile<Settings>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'json-settings-file-'));
    file = JsonSettingsFile.inDir(dir, 'settings.json', schema, defaults);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const onDisk = async (): Promise<Settings> =>
    JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as Settings;

  it('keeps every field when two updates are in flight together', async () => {
    await file.read();
    const [first, second] = await Promise.all([
      file.update({ provider: 'openrouter' }),
      file.update({ jevSource: 'openrouter' }),
    ]);
    expect(first).toEqual({ provider: 'openrouter', jevSource: 'auto', days: 7 });
    expect(second).toEqual({ provider: 'openrouter', jevSource: 'openrouter', days: 7 });
    expect(await file.read()).toEqual(second);
    expect(await onDisk()).toEqual(second);
  });

  it('keeps every field when the first updates arrive before the file was ever read', async () => {
    await Promise.all([
      file.update({ provider: 'openrouter' }),
      file.update({ jevSource: 'openrouter' }),
      file.update({ days: 3 }),
    ]);
    const expected = { provider: 'openrouter', jevSource: 'openrouter', days: 3 };
    expect(await file.read()).toEqual(expected);
    expect(await onDisk()).toEqual(expected);
  });

  it('rejects an invalid update without blocking the next one', async () => {
    await expect(file.update({ days: 0 })).rejects.toThrow();
    await expect(file.update({ days: 5 })).resolves.toEqual({ ...defaults, days: 5 });
    expect(await onDisk()).toEqual({ ...defaults, days: 5 });
  });

  it('reads the saved settings back in a new instance', async () => {
    await file.update({ provider: 'openrouter' });
    const reopened = JsonSettingsFile.inDir(dir, 'settings.json', schema, defaults);
    expect(await reopened.read()).toEqual({ ...defaults, provider: 'openrouter' });
  });
});
