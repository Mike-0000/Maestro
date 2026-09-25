import { passOnboarding } from './explore.mjs';
import { openDemoProject } from './open-project.mjs';

/**
 * Creates a task in chorus-demo with an idle agent (no prompt, so no tokens are spent).
 * `agentLabel` is the visible name in the agent selector, e.g. "Claude Code" or "Codex".
 */
export async function createIdleAgentTask(page, { taskName, agentLabel }) {
  await page.getByRole('button', { name: 'New task for chorus-demo' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Task name').waitFor();
  await page.keyboard.type(taskName);
  // Wait for agent detection to preselect something, then switch if needed.
  await dialog.getByText(/Claude Code|Codex|Cursor|Antigravity|Pi/).first().waitFor({ timeout: 60000 });
  if (!(await dialog.getByText(agentLabel, { exact: true }).isVisible().catch(() => false))) {
    await dialog.getByText(/Claude Code|Codex|Cursor|Antigravity|Autohand Code|Oh My Pi|^Pi$/).first().click();
    await page.getByRole('option', { name: new RegExp(agentLabel) }).first().click();
  }
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await page.waitForTimeout(3000);
}

export default async function createTask({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await page.waitForTimeout(15000);
  await createIdleAgentTask(page, { taskName: 'canvas-smoke', agentLabel: 'Claude Code' });
  await page.waitForTimeout(15000);
  await shot('task-created');
  log(await page.evaluate(() => document.body.innerText.slice(0, 1500)));
}
