/**
 * What a report's Done does: archive the task, and say so when that fails. It never navigates
 * itself: archiving leaves the task's view on its own once it succeeded and the task is the one on
 * screen, and a task that stays unarchived keeps its view.
 *
 * `archive` is null when the task's project has no task manager (nothing to archive).
 */
export async function finishTask(
  archive: (() => Promise<void>) | null,
  onFailure: (error: unknown) => void
): Promise<void> {
  if (!archive) return;
  try {
    await archive();
  } catch (error) {
    onFailure(error);
  }
}
