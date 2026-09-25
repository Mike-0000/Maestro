import { createServer } from 'node:http';
import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/**
 * End-to-end voice test with no cloud calls: a mock whisper-server answers /inference, so a
 * spoken (fake-device) utterance flows mic → WAV → main → engine → conductor grammar → canvas.
 * Run with --fake-mic.
 */
const PORT = 18178;
const TRANSCRIPT = 'Take a note: voice works end to end.';

async function hudText(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );
}

export default async function voiceE2e({ app, page, shot, log }) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const riff = body.indexOf('RIFF');
      requests.push({
        url: req.url,
        contentType: req.headers['content-type'],
        bytes: body.length,
        hasWav: riff >= 0 && body.subarray(riff + 8, riff + 12).toString() === 'WAVE',
        hasPrompt: body.includes('name="prompt"'),
        language: /name="language"\r\n\r\n(\w+)/.exec(body.toString('latin1'))?.[1] ?? null,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: TRANSCRIPT }));
    });
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  try {
    await passOnboarding(page);
    await openDemoProject({ app, page });
    await page.waitForTimeout(6000);

    // Configure the local engine through the settings UI.
    await page.getByRole('button', { name: 'Voice and conductor settings' }).click();
    await page.waitForTimeout(2500);
    await page.getByText('OpenAI (gpt-4o-transcribe)').click();
    await page.getByRole('option', { name: 'Local whisper.cpp server' }).click();
    await page.waitForTimeout(1000);
    const url = page.getByRole('textbox', { name: 'whisper-server URL' });
    await url.fill(`http://127.0.0.1:${PORT}`);
    await url.press('Enter');
    await page.waitForTimeout(1000);
    await shot('voice-settings-local');

    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await page.waitForTimeout(4000);
    const notesBefore = await page.locator('textarea[placeholder^="Write a goal"]').count();

    await page.getByRole('button', { name: 'Start listening' }).click();
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await page.waitForTimeout(4000);
    log('hud:', await hudText(page));
    log('whisper requests:', JSON.stringify(requests));
    const notesAfter = await page.locator('textarea[placeholder^="Write a goal"]').count();
    log(`notes on canvas: ${notesBefore} -> ${notesAfter}`);
    await shot('voice-e2e');
  } finally {
    server.close();
  }
}
