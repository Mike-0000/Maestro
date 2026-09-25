import { createIdleAgentTask } from './create-task.mjs';
import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

async function ensureTask(page, taskName, agentLabel) {
  if (
    await page
      .getByText(taskName, { exact: true })
      .first()
      .isVisible()
      .catch(() => false)
  )
    return;
  await createIdleAgentTask(page, { taskName, agentLabel });
  await page.waitForTimeout(8000);
}

export default async function canvas({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(8000);
  await ensureTask(page, 'canvas-smoke', 'Claude Code');
  await ensureTask(page, 'codex-smoke', 'Codex');

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.waitForTimeout(6000);
  await shot('canvas-initial');
  await page.getByRole('button', { name: 'Fit all agents' }).click();
  await page.waitForTimeout(2500);
  await shot('canvas-fit');
  log(
    await page.evaluate(
      () => document.querySelector('.react-flow')?.innerText.slice(0, 1500) ?? 'no board'
    )
  );

  const focusButtons = page.getByRole('button', { name: 'Focus (100 %)' });
  log('tiles with focus buttons:', await focusButtons.count());
  if ((await focusButtons.count()) > 0) {
    await focusButtons.first().click();
    await page.waitForTimeout(4000);
    await shot('canvas-focused');
  }
}
