// Onboarding → home, then dump the interactive elements for exploration.
export async function passOnboarding(page) {
  await page.waitForTimeout(5000);
  for (const name of ['Skip for now', 'Start shipping']) {
    const button = page.getByRole('button', { name });
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(2500);
    }
  }
}

export async function dumpButtons(page, log) {
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button,a,[role=button]')]
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 80)
  );
  log('buttons:', JSON.stringify(buttons));
}

export default async function explore({ page, shot, log }) {
  await passOnboarding(page);
  await shot('home');
  await dumpButtons(page, log);
}
