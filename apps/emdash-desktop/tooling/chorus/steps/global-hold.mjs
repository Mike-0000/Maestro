import { passOnboarding } from './explore.mjs';

/** Checks the system-wide hold-to-talk hook started (profile has globalHoldKey set). */
export default async function globalHold({ page, shot, log }) {
  await passOnboarding(page);
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
  await page.waitForTimeout(2500);
  const row = page.getByText('Hold to talk anywhere').locator('xpath=ancestor::*[.//button][1]');
  log('row:', (await row.innerText()).replace(/\n+/g, ' | '));
  await shot('global-hold');
}
