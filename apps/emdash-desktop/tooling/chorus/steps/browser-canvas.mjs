import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIdleAgentTask } from './create-task.mjs';
import { passOnboarding } from './explore.mjs';
import { DEMO_REPO, openDemoProject } from './open-project.mjs';

const FIXTURE_PORT = 5199;
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}/`;

/** A tiny app with a form and a load counter, run by the demo repo's `run` script. */
const FIXTURE_SERVER = `import http from 'node:http';

const port = Number(process.env.FIXTURE_PORT ?? ${FIXTURE_PORT});
let loads = 0;
const page = \`<!doctype html>
<html><head><title>Fixture app</title>
<style>body{font:16px system-ui;margin:40px;background:#fafafa}button{font-size:16px;padding:6px 14px}</style>
</head><body>
<h1>Fixture app</h1>
<label>Name <input id="name" aria-label="Name"></label>
<button id="save" onclick="document.getElementById('out').textContent='Saved '+document.getElementById('name').value">Save</button>
<p id="out" role="status">Not saved</p>
<p>Loads: <span id="loads"></span></p>
<script>fetch('/loads').then(r=>r.text()).then(t=>document.getElementById('loads').textContent=t)</script>
</body></html>\`;

http
  .createServer((req, res) => {
    if (req.url === '/loads') {
      res.end(String(loads));
      return;
    }
    if (req.url === '/') loads++;
    res.setHeader('Content-Type', 'text/html');
    res.end(page);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(\`  Local:   http://localhost:\${port}/\`);
  });
`;

function worktrees() {
  return execFileSync('git', ['-C', DEMO_REPO, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

/** Writes the fixture app and its run script into a checkout; commits when asked (idempotent). */
function writeFixture(root, log, { commit }) {
  const dir = join(root, 'fixture');
  mkdirSync(dir, { recursive: true });
  const serverFile = join(dir, 'server.mjs');
  const configFile = join(root, '.emdash.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  const nextConfig = { ...config, scripts: { ...config.scripts, run: 'node fixture/server.mjs' } };
  const unchanged =
    existsSync(serverFile) &&
    readFileSync(serverFile, 'utf8') === FIXTURE_SERVER &&
    JSON.stringify(config) === JSON.stringify(nextConfig);
  if (unchanged) return;
  writeFileSync(serverFile, FIXTURE_SERVER);
  writeFileSync(configFile, `${JSON.stringify(nextConfig, null, 2)}\n`);
  log(`fixture app written to ${root}`);
  if (!commit) return;
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('add', 'fixture/server.mjs', '.emdash.json');
  git(
    '-c',
    'user.name=chorus-drive',
    '-c',
    'user.email=drive@localhost',
    'commit',
    '-m',
    'fixture app'
  );
  log('committed fixture app and run script');
}

async function fixtureLoads() {
  const response = await fetch(`http://127.0.0.1:${FIXTURE_PORT}/loads`).catch(() => null);
  return response ? Number(await response.text()) : null;
}

/** Main-process view of the canvas guest showing the fixture. */
function guestInfo(app) {
  return app.evaluate(({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(url));
    return guest ? { id: guest.id, url: guest.getURL(), pid: guest.getOSProcessId() } : null;
  }, FIXTURE_URL);
}

async function waitFor(check, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

/**
 * Canvas app browser end to end: "Run app" starts the fixture through the run script and opens
 * it on the canvas; then the P0 spikes run against the real build:
 *   S1 the shell-level webview tracks its tile during a pan and never reloads,
 *   S2 a hidden guest still captures (and what that costs),
 *   S3 CDP on a guest: AX tree, Input.* clicks and typing, and DevTools coexistence.
 */
export default async function browserCanvas({ app, page, shot, log }) {
  writeFixture(DEMO_REPO, log, { commit: true });
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(8000);
  const before = new Set(worktrees());
  await createIdleAgentTask(page, { taskName: 'app-browser', agentLabel: 'Claude Code' });
  const worktree = await waitFor(() => worktrees().find((path) => !before.has(path)), 30_000);
  if (!worktree) throw new Error('The new task has no worktree');
  // New worktrees may fork from an older commit; make sure this one has the fixture.
  writeFixture(worktree, log, { commit: false });
  await page.waitForTimeout(8000);
  await page.keyboard.press('Control+Shift+A');
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Fit all agents' }).click();
  await page.waitForTimeout(1500);
  await shot('canvas');

  // ── Run app ────────────────────────────────────────────────────────────────
  const run = page.getByRole('button', { name: 'Run app' }).last();
  if (await run.isVisible().catch(() => false)) {
    await run.click();
    log('clicked Run app');
  } else {
    log('Run app not visible; the fixture may already run');
    await page
      .getByRole('button', { name: /^(Open|Show) app$/ })
      .last()
      .click();
  }
  const tile = page.locator('.react-flow__node-browser').first();
  await tile.waitFor({ timeout: 90_000 });
  const guest = await waitFor(() => guestInfo(app), 30_000);
  if (!guest) throw new Error('No webview guest loaded the fixture app');
  log('guest', guest);
  await shot('app-opened');

  // Show the tile at 100 % so the page is live.
  await tile.getByRole('button', { name: 'Focus (100 %)' }).click();
  await page.waitForTimeout(1500);
  const loadsBefore = await fixtureLoads();
  log('fixture loads before pan:', loadsBefore);
  await shot('app-live');

  // ── S1: tracking and no reload while panning ───────────────────────────────
  const pane = page.locator('.react-flow__pane');
  const paneBox = await pane.boundingBox();
  const samples = [];
  if (paneBox) {
    const tileBox = await tile.boundingBox();
    // Grab empty board just left of the tile and pan in small steps, sampling alignment.
    const startX = Math.max(paneBox.x + 10, (tileBox?.x ?? paneBox.x + 40) - 30);
    const startY = paneBox.y + paneBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let step = 1; step <= 30; step++) {
      await page.mouse.move(startX + step * 3, startY + step * 2);
      samples.push(
        await page.evaluate(() => {
          const node = document.querySelector('[data-browser-page]');
          const surface = document.querySelector('[data-browser-surface]');
          if (!node || !surface) return null;
          const a = node.getBoundingClientRect();
          const b = surface.getBoundingClientRect();
          const live = getComputedStyle(surface).opacity === '1';
          return {
            dx: live ? Math.abs(a.left - b.left) : 0,
            dy: live ? Math.abs(a.top - b.top) : 0,
            visible: live ? 'visible' : 'hidden',
          };
        })
      );
    }
    await page.mouse.up();
  }
  const aligned = samples.filter(Boolean);
  const maxDelta = Math.max(0, ...aligned.map((sample) => Math.max(sample.dx, sample.dy)));
  const visibleShare = aligned.filter((sample) => sample.visible === 'visible').length;
  await page.waitForTimeout(1500);
  const loadsAfterPan = await fixtureLoads();
  log(
    `S1: ${aligned.length} samples, max misalignment ${maxDelta.toFixed(1)} px, ` +
      `live in ${visibleShare}/${aligned.length}; loads ${loadsBefore} -> ${loadsAfterPan}`
  );
  await shot('after-pan');

  // Leaving and re-entering the canvas must not reload the page either.
  await page.keyboard.press('Control+Shift+A');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+Shift+A');
  await page.waitForTimeout(2000);
  log('S1: loads after leaving and re-entering the canvas:', await fixtureLoads());

  // ── S2: capture while hidden ───────────────────────────────────────────────
  await page.getByRole('button', { name: 'Fit all agents' }).click();
  await page.waitForTimeout(1500);
  const s2 = await app.evaluate(async ({ webContents, app: electronApp }, id) => {
    const wc = webContents.fromId(id);
    if (!wc) return { error: 'guest gone' };
    const started = Date.now();
    const image = await Promise.race([
      wc.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!image) return { error: 'capturePage did not settle within 5 s', ms: Date.now() - started };
    const size = image.getSize();
    const metrics = electronApp.getAppMetrics().find((m) => m.pid === wc.getOSProcessId());
    return {
      ms: Date.now() - started,
      width: size.width,
      height: size.height,
      empty: image.isEmpty(),
      bytes: image.toJPEG(70).length,
      workingSetMb: metrics ? Math.round(metrics.memory.workingSetSize / 1024) : null,
    };
  }, guest.id);
  log('S2: hidden capture', s2);
  log(
    'S2: tile shows a snapshot:',
    await tile
      .locator('img')
      .first()
      .isVisible()
      .catch(() => false)
  );
  await shot('snapshot');

  // ── S3: CDP on the guest ───────────────────────────────────────────────────
  const s3 = await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    if (!wc) return { error: 'guest gone' };
    const out = {};
    const dbg = wc.debugger;
    const attach = () => {
      if (!dbg.isAttached()) dbg.attach('1.3');
    };
    try {
      attach();
      // As BrowserAutomation does: the guest is not the focused widget while hidden.
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      const ax = await dbg.sendCommand('Accessibility.getFullAXTree');
      out.axNodes = ax.nodes.length;
      out.hasSaveButton = ax.nodes.some(
        (node) => node.role?.value === 'button' && node.name?.value === 'Save'
      );
      const doc = await dbg.sendCommand('DOM.getDocument');
      const input = await dbg.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#name',
      });
      await dbg.sendCommand('DOM.focus', { nodeId: input.nodeId });
      const probe = async () =>
        (
          await dbg.sendCommand('Runtime.evaluate', {
            expression:
              "JSON.stringify({ active: document.activeElement?.id, hasFocus: document.hasFocus(), value: document.getElementById('name').value })",
            returnByValue: true,
          })
        ).result.value;
      out.afterFocus = await probe();
      await dbg.sendCommand('Input.insertText', { text: 'Chorus' });
      out.afterInsertText = await probe();
      if (!JSON.parse(out.afterInsertText).value) {
        // BrowserAutomation's fallback when a hidden guest drops insertText.
        await dbg.sendCommand('Runtime.evaluate', {
          expression:
            "(() => { const el = document.activeElement; el.setRangeText('Chorus', el.selectionStart, el.selectionEnd, 'end'); el.dispatchEvent(new InputEvent('input', { bubbles: true })); })()",
        });
        out.afterFallback = await probe();
      }
      const button = await dbg.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#save',
      });
      const box = await dbg.sendCommand('DOM.getBoxModel', { nodeId: button.nodeId });
      const [x1, y1, , , x3, y3] = box.model.content;
      const x = (x1 + x3) / 2;
      const y = (y1 + y3) / 2;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      out.status = await wc.executeJavaScriptInIsolatedWorld(4217, [
        { code: "document.getElementById('out').textContent" },
      ]);
      const shotResult = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg' });
      out.cdpScreenshotBytes = shotResult.data.length;
    } catch (error) {
      out.error = String(error);
    }
    try {
      dbg.detach();
    } catch {}
    // DevTools coexistence: open DevTools on the guest, then try to attach again.
    wc.openDevTools({ mode: 'detach' });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      attach();
      const again = await dbg.sendCommand('Accessibility.getFullAXTree');
      out.withDevTools = `attached, ${again.nodes.length} AX nodes`;
      dbg.detach();
    } catch (error) {
      out.withDevTools = `attach failed: ${String(error)}`;
    }
    wc.closeDevTools();
    return out;
  }, guest.id);
  log('S3: CDP on guest', s3);
  if (s3.status !== 'Saved Chorus') log('S3: WARNING click/typing did not reach the page');
  await shot('after-cdp');

  // ── Control toggle and cleanup ─────────────────────────────────────────────
  await tile.getByRole('button', { name: 'Focus (100 %)' }).click();
  await page.waitForTimeout(1000);
  const toggle = tile.getByRole('button', { name: /^(You|Agents)$/ });
  log('control before:', await toggle.innerText());
  await toggle.click();
  await page.waitForTimeout(1500);
  log('control after:', await toggle.innerText());
  await shot('control-toggled');

  await page.getByRole('button', { name: 'Stop app' }).last().click();
  await page.waitForTimeout(3000);
  log('fixture reachable after Stop app:', (await fixtureLoads()) !== null);
  await shot('stopped');
}
