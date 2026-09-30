import { createServer } from 'node:http';
import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/**
 * Jev routing end to end with a mock System One endpoint. Run with
 * TYPESAFE_API_KEY=test TYPESAFE_BASE_URL=http://127.0.0.1:18179 so no real key is used.
 * An utterance the grammar cannot parse is routed by Jev to "focus Codex 1" without Claude: the
 * mock answers the router fan-out (addressee, intent, target, joint action) and nothing else.
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
      const target = targets.find((name) => name.startsWith('Codex')) ?? '(not about an agent)';
      const choice = (pick, confidence = 0.93) => ({
        type: 'choice',
        choice: pick,
        probabilities: { [pick]: confidence },
        confidence,
      });
      // A confident "focus Codex N" reading: the slots and the joint catalog agree.
      const routing = {
        addressee: choice('command_for_chorus'),
        stt_artifact: { type: 'noul', noul: 0.01 },
        answers_question: { type: 'noul', noul: 0.02 },
        correction_slot: choice('none'),
        intent: choice('focus'),
        target: choice(target, 0.91),
        agent_count: {
          type: 'score',
          score: 0,
          probabilities: { 0: 0.97, 1: 0.03 },
          confidence: 0.95,
        },
        action: choice(`focus · ${target}`, 0.88),
      };
      const answers = Object.fromEntries(
        Object.keys(body.questions)
          .filter((id) => id in routing)
          .map((id) => [id, routing[id]])
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-mock',
          answers,
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
