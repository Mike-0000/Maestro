import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Directories never worth showing a planner. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'coverage',
  '.idea',
  '.vscode',
]);
const MAX_ENTRIES_PER_DIR = 40;
const README_LINES = 40;
const HOT_SPOT_COMMITS = 30;
const MAX_CONTEXT_CHARS = 6_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function tree(root: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter((entry) => !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.DS_'))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
      );
    for (const entry of visible.slice(0, MAX_ENTRIES_PER_DIR)) {
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && depth < 2)
        await walk(join(dir, entry.name), `${prefix}  `, depth + 1);
    }
    if (visible.length > MAX_ENTRIES_PER_DIR) {
      lines.push(`${prefix}… ${visible.length - MAX_ENTRIES_PER_DIR} more`);
    }
  };
  await walk(root, '', 1);
  return lines;
}

async function scripts(root: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return Object.entries(pkg.scripts ?? {})
      .slice(0, 30)
      .map(([name, command]) => `${name}: ${command}`);
  } catch {
    return [];
  }
}

async function readmeHead(root: string): Promise<string[]> {
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      return (await readFile(join(root, name), 'utf8')).split(/\r?\n/).slice(0, README_LINES);
    } catch {
      // Try the next name.
    }
  }
  return [];
}

/** Directories touched most in recent commits: where parallel agents are likely to collide. */
async function hotSpots(root: string): Promise<string[]> {
  try {
    const log = await git(root, ['log', `-${HOT_SPOT_COMMITS}`, '--name-only', '--format=']);
    const counts = new Map<string, number>();
    for (const file of log
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)) {
      const dir = file.includes('/') ? file.split('/').slice(0, 2).join('/') : file;
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([dir, count]) => `${dir} (${count} changes)`);
  } catch {
    return [];
  }
}

const cache = new Map<string, { head: string; text: string }>();

/**
 * A compact picture of a repository for planning: layout (depth 2), package scripts, the README
 * opening, and recent hot spots. Cached per repository until HEAD moves.
 */
export async function readProjectContext(root: string): Promise<string | null> {
  let head: string;
  try {
    head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    head = 'no-head';
  }
  const cached = cache.get(root);
  if (cached?.head === head) return cached.text;

  const [layout, scriptLines, readme, hot] = await Promise.all([
    tree(root),
    scripts(root),
    readmeHead(root),
    hotSpots(root),
  ]);
  if (layout.length === 0) return null;
  const sections = [
    `Layout:\n${layout.join('\n')}`,
    scriptLines.length > 0 ? `package.json scripts:\n${scriptLines.join('\n')}` : '',
    hot.length > 0 ? `Recently changed most:\n${hot.join('\n')}` : '',
    readme.length > 0 ? `README (start):\n${readme.join('\n')}` : '',
  ].filter(Boolean);
  let text = sections.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n…`;
  cache.set(root, { head, text });
  return text;
}
