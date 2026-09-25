import { createServer } from 'node:http';
import { passOnboarding } from './explore.mjs';

/**
 * Hands-free mode and first-run voice setup, with no cloud calls (run with --fake-mic --fake-mic-bursts). A mock
 * whisper-server returns scripted transcripts; the profile must use the local engine at
 * http://127.0.0.1:18178 (the voice-e2e step configures that).
 */
const PORT = 18178;

async function hudText(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );
}

export default async function voiceHandsFree({ page, shot, log }) {
  const transcripts = [
    'Hello Chorus.',
    'Take a note: this should be ignored.',
    'Chorus, take a note: hands free works.',
  ];
  let served = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const text = transcripts[Math.min(served, transcripts.length - 1)];
      served++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text }));
    });
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  try {
    await passOnboarding(page);
    await page.waitForTimeout(3000);
    await page.keyboard.press('Control+Shift+A');
    await page.waitForTimeout(3000);

    // First-run setup: the "say hello" test transcribes without reaching the conductor.
    const setup = page.getByRole('button', { name: 'Set up voice' });
    log('setup offered:', await setup.isVisible().catch(() => false));
    if (await setup.isVisible().catch(() => false)) {
      await setup.click();
      await page
        .getByRole('region', { name: 'Voice setup' })
        .getByRole('button', { name: 'Test' })
        .click();
      await page.waitForTimeout(6000);
      log('setup:', await page.getByRole('region', { name: 'Voice setup' }).innerText());
      await shot('voice-setup');
      await page
        .getByRole('region', { name: 'Voice setup' })
        .getByRole('button', { name: /Done|Finish later/ })
        .click();
    } else {
      served++;
    }

    // Hands-free on (through settings), then let the fake device's tone trigger utterances.
    await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
    await page.waitForTimeout(2000);
    await page
      .getByText('Hands-free', { exact: true })
      .locator('xpath=ancestor::*[.//*[@role="switch"]][1]')
      .getByRole('switch')
      .click();
    await page.waitForTimeout(1000);
    await page.keyboard.press('Control+Shift+A');
    const notesBefore = await page.locator('textarea[placeholder^="Write a goal"]').count();
    await page.waitForTimeout(12000);
    log('hud:', (await hudText(page)).replace(/\n+/g, ' | ').slice(0, 300));
    const notesAfter = await page.locator('textarea[placeholder^="Write a goal"]').count();
    log(`notes: ${notesBefore} -> ${notesAfter}; whisper requests: ${served}`);
    await shot('hands-free');

    // Turn hands-free back off so the profile does not keep listening.
    await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
    await page.waitForTimeout(1500);
    await page
      .getByText('Hands-free', { exact: true })
      .locator('xpath=ancestor::*[.//*[@role="switch"]][1]')
      .getByRole('switch')
      .click();
    await page.waitForTimeout(500);
  } finally {
    server.close();
  }
}
