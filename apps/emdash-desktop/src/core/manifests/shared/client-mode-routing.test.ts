import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientSessionDomain } from '@core/features/client-mode/api/client-session-contract';
import { clientModeDomains, clientModeRouting, isHostServedPath } from './client-mode-routing';
import { desktopWireContract } from './desktop-wire-contract';
import { desktopDomainContracts } from './domain-contracts';

const ENDPOINT_KINDS = new Set([
  'procedure',
  'liveModel',
  'liveLog',
  'liveJob',
  'eventStream',
  'downloadFile',
  'uploadFile',
]);

/** Every endpoint path in a contract, dotted, in definition order. */
function endpointPaths(contract: object, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [name, entry] of Object.entries(contract)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const kind = (entry as { kind?: unknown }).kind;
    if (typeof kind === 'string' && ENDPOINT_KINDS.has(kind)) paths.push(path);
    else paths.push(...endpointPaths(entry as object, path));
  }
  return paths;
}

describe('client mode routing', () => {
  it('classifies every desktop domain and nothing else', () => {
    expect(Object.keys(clientModeRouting).sort()).toEqual(
      Object.keys(desktopDomainContracts).sort()
    );
  });

  it('keeps host and client sides consistent', () => {
    for (const [domain, route] of Object.entries(clientModeRouting)) {
      const where = `${domain}: ${JSON.stringify(route)}`;
      if (route.host === 'none') expect(route.client, where).toBe('local');
      if (route.client === 'local') expect(route.host, where).toBe('none');
      if (route.client === 'forward') expect(route.host, where).toBe('all');
    }
  });

  it('lists only endpoints that exist in their domain', () => {
    for (const [domain, route] of Object.entries(clientModeRouting)) {
      if (typeof route.host === 'string') continue;
      expect(route.host.length, domain).toBeGreaterThan(0);
      const known = endpointPaths(desktopDomainContracts[domain as keyof typeof clientModeRouting]);
      for (const path of route.host) expect(known, `${domain}.${path}`).toContain(path);
    }
  });

  it('answers host-served paths from the table', () => {
    expect(isHostServedPath('tasks', 'taskList.state')).toBe(true);
    expect(isHostServedPath('browser', 'registerSession')).toBe(false);
    expect(isHostServedPath('host', 'getPlatform')).toBe(true);
    expect(isHostServedPath('host', 'persistDroppedBlob')).toBe(true);
    expect(isHostServedPath('host', 'openExternal')).toBe(false);
    expect(isHostServedPath('host', 'getPlatformDisplayName')).toBe(false);
    expect(isHostServedPath('clientSession', 'status')).toBe(false);
    expect(isHostServedPath('constructor', 'x')).toBe(false);
    expect(isHostServedPath('__proto__', 'x')).toBe(false);
  });

  it('groups domains by client handling', () => {
    expect(clientModeDomains('local').sort()).toEqual(['browser', 'devPerf', 'logging', 'updates']);
    expect(clientModeDomains('custom').sort()).toEqual([
      'appSettings',
      'conversations',
      'host',
      'terminals',
      'voice',
    ]);
  });

  it('keeps the client session domain out of the desktop contract', () => {
    expect(Object.keys(desktopDomainContracts)).not.toContain(clientSessionDomain);
  });
});

describe('desktop wire surface', () => {
  // Any change to the local app's Wire surface shows up here in review. Update with `-u`.
  it('matches the recorded endpoint paths', () => {
    expect(endpointPaths(desktopWireContract)).toMatchSnapshot();
  });
});

// --- Import boundaries that keep client mode out of the local app -------------------------

const SRC = resolve(__dirname, '../../..');
const CLIENT_MAIN = join(SRC, 'main', 'client');
const CLIENT_MODE_BROWSER = join(SRC, 'core', 'primitives', 'client-mode', 'browser');
const ALIASES: Array<[string, string]> = [
  ['@main/', join(SRC, 'main')],
  ['@core/', join(SRC, 'core')],
  ['@renderer/', join(SRC, 'renderer')],
  ['@/', SRC],
];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/gu;

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

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  for (const [alias, target] of ALIASES) {
    if (specifier.startsWith(alias)) return join(target, specifier.slice(alias.length));
  }
  return undefined;
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

function importersOf(directory: string): string[] {
  const importers = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    if (isInside(file, directory)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const target = resolveSpecifier(match[1]!, file);
      if (target && isInside(target, directory)) importers.add(file);
    }
  }
  return [...importers].map((file) => relative(SRC, file).split(sep).join('/')).sort();
}

describe('client mode import boundaries', () => {
  it('reaches the client main process only from the app entry', () => {
    for (const importer of importersOf(CLIENT_MAIN)) {
      expect(importer).toBe('entry/main.ts');
    }
  });

  it('branches on client mode only in renderer code', () => {
    for (const importer of importersOf(CLIENT_MODE_BROWSER)) {
      const rendererSide = importer.startsWith('renderer/') || importer.includes('/browser/');
      expect(rendererSide, importer).toBe(true);
    }
  });
});
