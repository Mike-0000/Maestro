// First boot: capture whatever the app shows and dump its visible text.
export default async function smoke({ page, shot, log }) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(8000);
  await shot('boot');
  const text = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  log('visible text:\n' + text);
}
