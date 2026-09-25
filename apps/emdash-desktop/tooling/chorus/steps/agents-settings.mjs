import { dumpButtons, passOnboarding } from './explore.mjs';

export default async function agentsSettings({ page, shot, log }) {
  await passOnboarding(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.waitForTimeout(2000);
  await dumpButtons(page, log);
  const agents = page.getByText('Agents', { exact: true }).first();
  if (await agents.isVisible().catch(() => false)) await agents.click();
  await page.waitForTimeout(15000);
  await shot('agents-settings');
  const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  log('text:\n' + text);
}
