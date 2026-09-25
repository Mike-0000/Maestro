import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/** Task frames: render, drag a frame (its agents follow), review changes, open-on-launch. */
export default async function frames({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(6000);
  await page.keyboard.press('Control+Shift+A');
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Fit all agents' }).click();
  await page.waitForTimeout(1500);
  const frameCount = await page.locator('.react-flow__node-frame').count();
  log('frames:', frameCount);
  await shot('frames');

  const handle = page.locator('.chorus-frame-handle').first();
  const agent = page.locator('.react-flow__node-agent').first();
  const before = await agent.boundingBox();
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
  }
  await page.waitForTimeout(800);
  const after = await agent.boundingBox();
  log('agent moved with frame by', after && before ? Math.round(after.y - before.y) : 'n/a', 'px');
  await shot('frame-dragged');

  await page
    .locator('.chorus-frame-handle')
    .first()
    .getByTitle("Review this task's changes")
    .dispatchEvent('click');
  await page.waitForTimeout(3000);
  log(
    'view after review click:',
    await page.evaluate(
      () => document.title + ' | ' + (document.querySelector('main')?.innerText.slice(0, 200) ?? '')
    )
  );
  await shot('review-changes');

  await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
  await page.waitForTimeout(2000);
  log('settings has canvas section:', await page.getByText('Open on the canvas').isVisible());
  await shot('settings-canvas');
}
