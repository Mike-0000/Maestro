import { passOnboarding } from './explore.mjs';

/** Exercises mic capture → WAV → upload → main-process STT routing (run with --fake-mic). */
async function hudText(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );
}

export default async function voice({ page, shot, log }) {
  await passOnboarding(page);
  await page.waitForTimeout(4000);

  await page.getByRole('button', { name: 'Start listening' }).click();
  await page.waitForTimeout(1500);
  log('listening:', await hudText(page));
  await shot('voice-listening');
  await page.getByRole('button', { name: 'Stop listening' }).click();
  await page.waitForTimeout(4000);
  log('after click-to-talk:', await hudText(page));
  await shot('voice-result');

  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.down('ControlRight');
  await page.waitForTimeout(1500);
  log('holding right ctrl:', await hudText(page));
  await page.keyboard.up('ControlRight');
  await page.waitForTimeout(4000);
  log('after hold-to-talk:', await hudText(page));
}
