import { passOnboarding } from './explore.mjs';

/** Checks the Chorus keybindings and command palette entries. */
export default async function commands({ page, shot, log }) {
  await passOnboarding(page);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Control+Shift+A');
  await page.waitForTimeout(2500);
  log('after Ctrl+Shift+A, canvas visible:', await page.locator('.react-flow').isVisible());
  await page.keyboard.press('Control+Shift+J');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(800);
  await page.keyboard.type('agent needing');
  await page.waitForTimeout(800);
  await shot('palette');
  log(
    'palette has command:',
    await page.getByText('Jump to Next Agent Needing You').first().isVisible()
  );
  await page.keyboard.press('Escape');
}
