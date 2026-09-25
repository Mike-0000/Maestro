// Launches the built desktop app (out/) under Playwright with an isolated profile and runs a
// steps module against its first window. Dev-only verification tooling; never bundled.
//
//   node tooling/chorus/drive-app.mjs --steps tooling/chorus/steps/smoke.mjs \
//     [--profile <dir>] [--out <dir>] [--keep-open] [--fake-mic]
//
// A steps module default-exports `async ({ app, page, shot, log, profileDir }) => {}`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    // Feed Chromium's synthetic audio/video devices (a beeping tone) and auto-grant media access.
    'fake-mic': { type: 'boolean', default: false },
    // With --fake-mic: feed speech-like bursts (tone, then silence, looped) instead of a steady
    // tone, so onset and end-of-speech detection behave as they would with a person talking.
    'fake-mic-bursts': { type: 'boolean', default: false },
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
  args: [
    ...(values['fake-mic']
      ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
      : []),
    ...(values['fake-mic'] && values['fake-mic-bursts']
      ? [`--use-file-for-fake-audio-capture=${writeBurstsWav(join(outDir, 'bursts.wav'))}`]
      : []),
    appDir,
  ],
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

// oxlint-disable-next-line emdash/no-dynamic-imports -- the step module is chosen on the command line.
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
  if (!values['keep-open']) await quitApp();
}
process.exit(exitCode);

/**
 * Quits through the app's own quit path, answering the "Quit Chorus?" confirmation (and
 * discarding unsaved files if asked), then kills the process if it still has not exited.
 */
async function quitApp() {
  const child = app.process();
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  });
  // app.quit() runs the app's own before-quit guard, which asks for confirmation in the page;
  // Playwright's app.close() would sever the page connection before we could answer it.
  void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const done = await Promise.race([exited.then(() => true), sleep(500).then(() => false)]);
    if (done) return;
    // Button names include their shortcut hint ("QuitCtrl⏎"), so match the leading label.
    for (const name of [/^Quit/, /^Don.t save/, /^Discard/]) {
      const button = page
        .locator('[role="dialog"], [role="alertdialog"]')
        .getByRole('button', { name })
        .first();
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        log(`quit: clicked ${name}`);
      }
    }
  }
  log('quit: app did not exit in time; killing it');
  // child.kill() only ends the launcher on Windows; take down the whole Electron tree.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([exited, sleep(5_000)]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 1.2 s of a modulated tone then 2.5 s of silence, 48 kHz mono 16-bit, as a WAV file. */
function writeBurstsWav(path) {
  const rate = 48_000;
  const samples = Math.round(rate * 3.7);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const voiced = t < 1.2;
    const envelope = voiced ? 0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0;
    const value =
      envelope * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.3 * Math.sin(2 * Math.PI * 660 * t));
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}
