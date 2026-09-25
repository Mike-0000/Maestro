// Launches the built desktop app (out/) under Playwright with an isolated profile and runs a
// steps module against its first window. Dev-only verification tooling; never bundled.
//
//   node tooling/chorus/drive-app.mjs --steps tooling/chorus/steps/smoke.mjs \
//     [--profile <dir>] [--out <dir>] [--keep-open]
//
// A steps module default-exports `async ({ app, page, shot, log, profileDir }) => {}`.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../..');

const { values } = parseArgs({
  options: {
    steps: { type: 'string' },
    profile: { type: 'string' },
    out: { type: 'string' },
    'keep-open': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '600000' },
  },
});

if (!values.steps) {
  console.error('--steps <module> is required');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profileDir = resolve(values.profile ?? join(tmpdir(), 'chorus-drive', stamp));
const outDir = resolve(values.out ?? join(appDir, '.chorus-shots', stamp));
mkdirSync(profileDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  EMDASH_USER_DATA_DIR: profileDir,
  EMDASH_DB_FILE: join(profileDir, 'emdash4.db'),
  EMDASH_LOG_FILE: join(profileDir, 'emdash.log'),
  TELEMETRY_ENABLED: 'false',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
});

const log = (...args) => console.log('[drive]', ...args);
log('profile', profileDir);
log('screenshots', outDir);

const app = await electron.launch({
  args: [appDir],
  cwd: appDir,
  env,
  timeout: 120_000,
});
const page = await app.firstWindow({ timeout: 120_000 });
page.on('console', (message) => {
  if (message.type() === 'error') log('renderer error:', message.text());
});
page.on('pageerror', (error) => log('page error:', error.message));

let shotIndex = 0;
const shot = async (name) => {
  const file = join(outDir, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log('shot', file);
  return file;
};

const steps = (await import(pathToFileURL(resolve(values.steps)).href)).default;
const deadline = setTimeout(() => {
  log('timed out');
  process.exit(3);
}, Number(values.timeout));

let exitCode = 0;
try {
  await steps({ app, page, shot, log, profileDir, outDir });
} catch (error) {
  exitCode = 1;
  log('step failure:', error instanceof Error ? error.stack : error);
  await shot('failure').catch(() => {});
} finally {
  clearTimeout(deadline);
  if (!values['keep-open']) await app.close().catch(() => {});
}
process.exit(exitCode);
