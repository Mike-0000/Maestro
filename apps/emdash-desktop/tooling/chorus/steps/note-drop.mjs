import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/** Drops a note on an agent tile, cancels the send, then checks history and Windows checks. */
async function hudText(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );
}

export default async function noteDrop({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Fit all agents' }).click();
  await page.waitForTimeout(1500);

  // Create a note with text, then drag it by its header onto the first agent tile.
  await page.getByRole('button', { name: 'Add a note' }).click();
  await page.waitForTimeout(1200);
  const note = page.locator('textarea[placeholder^="Write a goal"]').last();
  await note.fill('run the unit tests');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Fit all agents' }).click();
  await page.waitForTimeout(1500);
  const noteNode = page.locator('.react-flow__node-note').last();
  const agentNode = page.locator('.react-flow__node').filter({ hasText: 'canvas-smoke' }).first();
  const from = await noteNode.boundingBox();
  const to = await agentNode.boundingBox();
  log('boxes', JSON.stringify({ from, to }));
  if (from && to) {
    await page.mouse.move(from.x + from.width / 2, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  log('after drop:', await hudText(page));
  await shot('note-drop-pending');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  log('after cancel:', await hudText(page));

  await page.getByRole('button', { name: 'Conductor history' }).click();
  await page.waitForTimeout(1500);
  log('history:', await hudText(page));
  await shot('history');
  await page.getByRole('button', { name: 'Conductor history' }).click();

  await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
  await page.waitForTimeout(2500);
  await shot('settings-windows-checks');
  log(
    'long paths card visible:',
    await page
      .getByText('Git long paths are off')
      .isVisible()
      .catch(() => false)
  );
}
