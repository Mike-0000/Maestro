import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/** Drives the conductor through typed commands (grammar path only, so no API tokens are spent). */
async function typeCommand(page, text) {
  const input = page.getByRole('textbox', { name: 'Command' });
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Type a command' }).click();
  }
  await input.fill(text);
  await input.press('Enter');
}

async function hudText(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );
}

export default async function conductor({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(8000);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.waitForTimeout(5000);
  log('hud idle:', await hudText(page));
  await shot('hud-idle');

  await typeCommand(page, 'take a note: ship the voice HUD');
  await page.waitForTimeout(1500);
  log('after note:', await hudText(page));

  await typeCommand(page, 'what is claude 1 doing');
  await page.waitForTimeout(3000);
  log('after status:', await hudText(page));
  await shot('hud-status');

  await typeCommand(page, 'tell codex 1 to say hello');
  await page.waitForTimeout(400);
  log('pending:', await hudText(page));
  await shot('hud-pending');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  log('after cancel:', await hudText(page));

  await typeCommand(page, 'show all');
  await page.waitForTimeout(1500);
  await typeCommand(page, 'refactor the whole thing into three packages please');
  await page.waitForTimeout(3000);
  log('llm without key:', await hudText(page));
  await shot('hud-no-key');

  await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
  await page.waitForTimeout(3000);
  await shot('settings-chorus');
  log(
    'settings:',
    await page.evaluate(() => document.querySelector('main')?.innerText.slice(0, 1200) ?? '')
  );
}
