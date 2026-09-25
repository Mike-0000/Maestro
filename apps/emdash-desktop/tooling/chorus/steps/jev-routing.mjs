import { createServer } from 'node:http';
import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/**
 * Jev routing end to end with a mock System One endpoint. Run with
 * TYPESAFE_API_KEY=test TYPESAFE_BASE_URL=http://127.0.0.1:18179 so no real key is used.
 * An utterance the grammar cannot parse is routed by Jev to "focus Codex 1" without Claude.
 */
const PORT = 18179;

async function hudText(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.innerText ?? 'no hud'
  );
}

export default async function jevRouting({ app, page, shot, log }) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({
        url: req.url,
        auth: req.headers.authorization,
        questions: Object.keys(body.questions),
      });
      const targets = Object.keys(body.questions.target?.criteria ?? {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-mock',
          answers: {
            intent: {
              type: 'choice',
              choice: 'focus',
              probabilities: { focus: 0.96 },
              confidence: 0.93,
            },
            target: {
              type: 'choice',
              choice: targets.find((name) => name.startsWith('Codex')) ?? '(none)',
              probabilities: {},
              confidence: 0.91,
            },
            decompose: { type: 'noul', noul: 0.03 },
          },
          usage: { input_tokens: 200, output_tokens: 10 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  try {
    await passOnboarding(page);
    await openDemoProject({ app, page });
    await page.waitForTimeout(6000);
    await page.keyboard.press('Control+Shift+A');
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: 'Type a command' }).click();
    const input = page.getByRole('textbox', { name: 'Command' });
    await input.fill('can you bring up the codecs agent for me');
    await input.press('Enter');
    await page.waitForTimeout(2500);
    log('jev requests:', JSON.stringify(requests));
    log(
      'focused tile:',
      await page.evaluate(
        () =>
          document
            .querySelector('.react-flow__node-agent .ring-2')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? 'none'
      )
    );
    await page.getByRole('button', { name: 'Conductor history' }).click();
    await page.waitForTimeout(1200);
    log('hud:', (await hudText(page)).split('\n').slice(0, 8).join(' | '));
    await shot('jev-routed');
  } finally {
    server.close();
  }
}
