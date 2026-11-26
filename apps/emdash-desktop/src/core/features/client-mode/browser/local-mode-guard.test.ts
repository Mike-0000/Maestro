import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The local app must not change: client-mode UI may be mounted only from the files below, and
// in each of them only behind `isClientMode()`.

const SRC = resolve(__dirname, '../../../..');
const FEATURE = join(SRC, 'core', 'features', 'client-mode');

/** The only files outside the feature that import its UI, with the symbol each may use. */
const FEATURE_MOUNT_SITES: Record<string, string> = {
  'renderer/main.tsx': 'runClientGate(',
  'renderer/App.tsx': '<ConnectionOverlay',
};

/** Every guarded mount, including the title bars' slot, which the feature fills at boot. */
const MOUNT_SITES: Record<string, string> = {
  ...FEATURE_MOUNT_SITES,
  'core/features/workbench/contributions/browser/Titlebar.tsx': '<ClientTitlebarStatus',
  'core/features/workbench/contributions/browser/BorderlessTitlebar.tsx': '<ClientTitlebarStatus',
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const toKey = (file: string) => relative(SRC, file).split(sep).join('/');

describe('client-mode UI stays out of the local app', () => {
  it('is imported only by its mount sites', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => !file.startsWith(FEATURE + sep))
      .filter((file) =>
        /from '@core\/features\/client-mode\/(?:browser|contributions)\//u.test(
          readFileSync(file, 'utf8')
        )
      )
      .map(toKey)
      .sort();
    expect(importers).toEqual(Object.keys(FEATURE_MOUNT_SITES).sort());
  });

  it.each(Object.entries(MOUNT_SITES))('%s mounts it only in client mode', (file, symbol) => {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    const uses = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes(symbol));
    expect(uses.length).toBeGreaterThan(0);
    for (const { line, index } of uses) {
      // The guard is on the same line, or opens the JSX expression on the line above.
      const guarded =
        line.includes('isClientMode()') || (lines[index - 1] ?? '').endsWith('isClientMode() && (');
      expect(guarded, `${file}:${index + 1}: ${line.trim()}`).toBe(true);
    }
  });

  it('fills the title-bar slot only from the client-mode feature', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('registerClientTitlebarStatus('))
      .map(toKey)
      .sort();
    expect(callers).toEqual([
      'core/features/client-mode/browser/run-client-gate.tsx',
      'core/primitives/client-mode/browser/titlebar-status.tsx',
    ]);
  });

  it('never reads the client session at import time', () => {
    for (const file of sourceFiles(FEATURE)) {
      const source = readFileSync(file, 'utf8');
      // Top-level statements start in column 0; a call there would run in a local window too.
      const topLevelCall = source
        .split('\n')
        .find((line) =>
          /^(?:void |await )?(?:getClientSessionStore|getClientSessionClient)\(/u.test(line)
        );
      expect(topLevelCall, toKey(file)).toBeUndefined();
    }
  });
});
