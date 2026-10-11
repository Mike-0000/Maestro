import { createIdleAgentTask } from './create-task.mjs';
import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/** Types a command into the conductor HUD (grammar path only, so no API tokens are spent). */
async function typeCommand(page, text) {
  const input = page.getByRole('combobox', { name: 'Command' });
  await input.fill(text);
  await input.press('Enter');
}

const hudText = (page) =>
  page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );

/** What Canvas Pro shows: the desk strip and the windows drawn on the desk in view. */
const deskState = (page) =>
  page.evaluate(() => {
    const text = (element) => element.innerText.replace(/\s+/g, ' ').trim();
    const tabs = [
      ...document.querySelectorAll('[role="tablist"][aria-label="Desks"] [role="tab"]'),
    ];
    const names = (selector) =>
      [...document.querySelectorAll(selector)].map((node) => text(node).slice(0, 40));
    return {
      desks: tabs.map(
        (tab) => `${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}${text(tab)}`
      ),
      agents: document.querySelectorAll('.react-flow__node-agent').length,
      notes: document.querySelectorAll('.react-flow__node-note').length,
      scrim: document.querySelectorAll('.react-flow__node-scrim').length,
      visiting: names('[title^="Visiting from other desks"]'),
      zoom: document.querySelector('.react-flow__viewport')?.style.transform ?? '',
    };
  });

/**
 * How much of the canvas the windows on the desk in view cover, and the zoom they are drawn at.
 * A desk always fills the screen: the share is everything but the toolbar band and the gaps.
 */
const deskFill = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (!pane) return { share: 0, zoom: 0, windows: 0 };
    const nodes = [
      ...document.querySelectorAll(
        '.react-flow__node-agent, .react-flow__node-note, .react-flow__node-browser, .react-flow__node-doc'
      ),
    ];
    let covered = 0;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const w = Math.min(rect.right, pane.right) - Math.max(rect.left, pane.left);
      const h = Math.min(rect.bottom, pane.bottom) - Math.max(rect.top, pane.top);
      if (w > 0 && h > 0) covered += w * h;
    }
    const transform = document.querySelector('.react-flow__viewport')?.style.transform ?? '';
    return {
      share: covered / (pane.width * pane.height),
      zoom: Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 0),
      windows: nodes.length,
    };
  });

async function ensureTask(page, taskName, agentLabel) {
  if (
    await page
      .getByText(taskName, { exact: true })
      .first()
      .isVisible()
      .catch(() => false)
  )
    return;
  await createIdleAgentTask(page, { taskName, agentLabel });
  await page.waitForTimeout(8000);
}

function expect(condition, message) {
  if (!condition) throw new Error(`desks: ${message}`);
}

/**
 * Canvas Pro: enter it, make and rename a desk, swap, borrow a window from another desk, and
 * remove a desk, by pointer and by typed commands. Asserts the desk strip after each step.
 */
export default async function desks({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(8000);
  await ensureTask(page, 'desk-one', 'Claude Code');
  await ensureTask(page, 'desk-two', 'Codex');

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.waitForTimeout(6000);
  await shot('classic');

  // Into Canvas Pro: loose windows land on Main, which fills the screen.
  await page.getByRole('button', { name: /^Switch to Canvas Pro/ }).click();
  await page.waitForTimeout(2500);
  let state = await deskState(page);
  log('pro:', JSON.stringify(state));
  expect(state.desks.length >= 1, 'no desk after entering Canvas Pro');
  expect(
    state.desks.some((desk) => desk.startsWith('*')),
    'no desk is in view'
  );
  const total = state.agents;
  expect(total >= 2, `expected the two agents on the first desk, saw ${total}`);
  await shot('pro-main');

  // The desk fills the screen at zoom 1: no board around it, no empty band inside it.
  const fill = await deskFill(page);
  log('fill:', JSON.stringify(fill));
  expect(fill.zoom === 1, `the desk is drawn at zoom ${fill.zoom}, not 1`);
  expect(fill.share > 0.7, `the windows cover only ${Math.round(fill.share * 100)}% of the canvas`);

  // A new desk by pointer, named in the strip.
  await page.getByRole('button', { name: 'New desk', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Desk name' });
  await field.fill('Review');
  await field.press('Enter');
  await page.waitForTimeout(1500);
  state = await deskState(page);
  log('new desk:', JSON.stringify(state));
  expect(
    state.desks.some((desk) => desk.startsWith('*Review')),
    'Review is not the desk in view'
  );
  expect(state.agents === 0, `an empty desk drew ${state.agents} agents`);
  await shot('pro-review-empty');

  // Swap back and forth by key: only the desk in view is drawn.
  await page.locator('.react-flow__pane').click({ position: { x: 400, y: 400 } });
  await page.keyboard.press('Control+Alt+PageUp');
  await page.waitForTimeout(1200);
  state = await deskState(page);
  log('previous desk:', JSON.stringify(state));
  expect(!state.desks.some((desk) => desk.startsWith('*Review')), 'still on Review after a swap');
  expect(state.agents === total, `the first desk drew ${state.agents} of ${total} agents`);
  await page.keyboard.press('Control+Alt+PageDown');
  await page.waitForTimeout(1200);
  state = await deskState(page);
  expect(
    state.desks.some((desk) => desk.startsWith('*Review')),
    'next desk did not reach Review'
  );

  // By voice (typed): borrow an agent from the other desk, then send it home.
  await typeCommand(page, 'bring atlas here');
  await page.waitForTimeout(1500);
  log('bring:', await hudText(page));
  state = await deskState(page);
  log('visiting:', JSON.stringify(state));
  expect(state.agents === 1, `expected one visiting agent on Review, saw ${state.agents}`);
  await shot('pro-visitor');
  await typeCommand(page, 'send it back');
  await page.waitForTimeout(1200);
  log('send back:', await hudText(page));
  state = await deskState(page);
  expect(state.agents === 0, 'the visitor did not go home');

  // Move a window for good, and see it float as a visitor over a desk with its own windows.
  await typeCommand(page, 'move atlas to the review desk');
  await page.waitForTimeout(1500);
  log('move:', await hudText(page));
  state = await deskState(page);
  expect(state.agents === 1, `Atlas did not move to Review (${state.agents} agents)`);
  await typeCommand(page, 'bring bravo here');
  await page.waitForTimeout(1500);
  state = await deskState(page);
  log('floating visitor:', JSON.stringify(state));
  expect(state.agents === 2 && state.scrim === 1, 'a visitor should float above the desk');
  await shot('pro-visitor-floating');
  await typeCommand(page, 'send it back');
  await page.waitForTimeout(1000);

  // More desks by voice, and around them.
  await typeCommand(page, 'new desk called Ops');
  await page.waitForTimeout(1500);
  log('new desk:', await hudText(page));
  state = await deskState(page);
  expect(
    state.desks.some((desk) => desk.startsWith('*Ops')),
    'Ops is not the desk in view'
  );
  await typeCommand(page, 'switch to the review desk');
  await page.waitForTimeout(1200);
  state = await deskState(page);
  expect(
    state.desks.some((desk) => desk.startsWith('*Review')),
    'did not switch to Review'
  );
  await typeCommand(page, 'make a desk for everything that needs me');
  await page.waitForTimeout(1500);
  log('gathering desk:', await hudText(page));
  await shot('pro-gathering');
  state = await deskState(page);
  log('desks:', JSON.stringify(state));

  // Removing a desk moves its windows; nothing closes.
  await typeCommand(page, 'switch to the review desk');
  await page.waitForTimeout(1200);
  await typeCommand(page, 'remove this desk');
  await page.waitForTimeout(4000);
  log('remove:', await hudText(page));
  state = await deskState(page);
  log('after remove:', JSON.stringify(state));
  expect(!state.desks.some((desk) => desk.includes('Review')), 'Review is still there');
  await shot('pro-removed');

  // Back to the classic canvas: the desks are regions on the one board again.
  await page.getByRole('button', { name: /^Canvas Pro: one desk at a time/ }).click();
  await page.waitForTimeout(2500);
  const agents = await page.evaluate(
    () => document.querySelectorAll('[role="tablist"][aria-label="Desks"]').length
  );
  expect(agents === 0, 'the desk strip is still showing on the classic canvas');
  await shot('classic-again');
}
