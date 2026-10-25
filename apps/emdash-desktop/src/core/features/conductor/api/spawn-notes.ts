/**
 * Facts about the agents already running, used when a new agent is spawned: a task name that
 * would read as another agent's name is changed, and the developer hears when another agent is
 * busy in the folder the new one starts in.
 */

export type SpawnPeer = {
  /** The name the developer says: its window name on the canvas. */
  readonly name: string;
  /** Another title it goes by. */
  readonly title?: string;
  readonly projectId: string;
  /** Roster status: "working" and "awaiting-input" mean busy. */
  readonly status: string;
  /** True when the agent works in its project's directory, not in a worktree. */
  readonly inProjectDirectory: boolean;
};

const BUSY = new Set(['working', 'awaiting-input']);

/** Case-insensitive, without a trailing number: "Quartz 2" and "quartz" are the same name. */
function nameKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s*#?\d+$/, '');
}

/**
 * The task name to use. A name equal to an existing agent's name or title would be read as that
 * agent ("Quartz re-rendered the logo" about another agent), so it becomes "<name> task".
 */
export function safeTaskName(
  taskName: string,
  peers: readonly SpawnPeer[]
): { name: string; note?: string } {
  const key = nameKey(taskName);
  const clash = peers.find(
    (peer) => nameKey(peer.name) === key || (peer.title && nameKey(peer.title) === key)
  );
  if (!key || !clash) return { name: taskName };
  const name = `${taskName.trim()} task`;
  return {
    name,
    note: `The task name "${taskName.trim()}" is also the name of agent ${clash.name}, so the task is named "${name}".`,
  };
}

/** One factual line when another agent is busy in the project directory the new one uses. */
export function busyInFolderNote(projectId: string, peers: readonly SpawnPeer[]): string | null {
  const names = peers
    .filter((peer) => peer.projectId === projectId && peer.inProjectDirectory)
    .filter((peer) => BUSY.has(peer.status))
    .map((peer) => peer.name);
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} also working in this folder.`;
}
