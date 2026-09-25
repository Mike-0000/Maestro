import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readProjectContext } from './project-context';

const root = mkdtempSync(join(tmpdir(), 'chorus-context-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

describe('readProjectContext', () => {
  it('summarizes layout, scripts, README, and hot spots while skipping noise', async () => {
    mkdirSync(join(root, 'src/api'), { recursive: true });
    mkdirSync(join(root, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(join(root, 'src/api/server.ts'), 'export {};\n');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } })
    );
    writeFileSync(join(root, 'README.md'), '# Demo\n\nA demo service.\n');
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');

    const text = await readProjectContext(root);
    expect(text).toContain('src/');
    expect(text).toContain('  api/');
    expect(text).not.toContain('node_modules');
    expect(text).toContain('test: vitest run');
    expect(text).toContain('# Demo');
    expect(text).toContain('src/api (1 changes)');
    // Cached until HEAD moves.
    expect(await readProjectContext(root)).toBe(text);
  });
});
