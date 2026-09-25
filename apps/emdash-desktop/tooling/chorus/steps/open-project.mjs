import { dumpButtons, passOnboarding } from './explore.mjs';

export const DEMO_REPO = 'C:/tmp/chorus-demo'.replaceAll('/', String.fromCharCode(92));

/** Makes the next native folder picker return `path` (the dialog itself cannot be automated). */
export async function stubFolderPicker(app, path) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
}

export async function openDemoProject({ app, page }) {
  const existing = page.getByText('chorus-demo', { exact: true });
  if (await existing.first().isVisible().catch(() => false)) return;
  await stubFolderPicker(app, DEMO_REPO);
  await page.getByRole('button', { name: 'Open project' }).first().click();
  await page.getByRole('button', { name: /Select a directory/ }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /^Create/ }).last().click();
  await page.waitForTimeout(5000);
}

export default async function openProject({ app, page, shot, log }) {
  await passOnboarding(page);
  await openDemoProject({ app, page });
  await shot('project-open');
  await dumpButtons(page, log);
}
