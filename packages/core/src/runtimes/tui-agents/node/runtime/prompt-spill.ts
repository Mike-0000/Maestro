import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Keep provider argv comfortably below the lowest practical OS command-line limit. */
export const MAX_INLINE_PROMPT_CHARS = 16_384;

const TEMP_DIR_PREFIX = 'emdash-tui-prompt-';
const CONTEXT_FILE_NAME = 'task-context.md';
const STALE_PROMPT_AGE_MS = 24 * 60 * 60 * 1_000;

export type PromptSpillResult = {
  prompt: string;
  spilled: boolean;
  cleanup: () => Promise<void>;
};

export type PromptSpillDeps = {
  maxChars?: number;
  /**
   * Also spill any prompt with a line break. On Windows the provider command line often runs
   * through cmd.exe (always for npm-style `.cmd` shims), which ends a command at a line break, so
   * an inline multi-line prompt would reach the agent cut to its first line.
   */
  spillLineBreaks?: boolean;
  createTempDir?: () => Promise<string>;
  writeContextFile?: (filePath: string, contents: string) => Promise<void>;
  removeTempDir?: (directory: string) => Promise<void>;
  onError?: (error: unknown, promptLength: number) => void;
};

export type StalePromptCleanupDeps = {
  now?: () => number;
  listTempEntries?: () => Promise<Array<{ name: string; isDirectory: boolean }>>;
  statTempEntry?: (name: string) => Promise<{ mtimeMs: number }>;
  removeTempEntry?: (name: string) => Promise<void>;
  onError?: (error: unknown) => void;
};

const noopCleanup = (): Promise<void> => Promise.resolve();

export function buildPromptPointerMessage(filePath: string): string {
  return (
    `The full task context could not be passed intact on the command line, so it has ` +
    `been written to a file. Read the file at ${filePath} and complete the task ` +
    `described in it.`
  );
}

/** True when a prompt must be spilled rather than passed inline on the provider command line. */
export function shouldSpillPrompt(
  prompt: string,
  options: Pick<PromptSpillDeps, 'maxChars' | 'spillLineBreaks'> = {}
): boolean {
  if (prompt.length > (options.maxChars ?? MAX_INLINE_PROMPT_CHARS)) return true;
  return options.spillLineBreaks === true && /[\r\n]/.test(prompt);
}

/**
 * Spill a large (or, with `spillLineBreaks`, multi-line) prompt on the machine that hosts the TUI
 * runtime. The returned pointer is still delivered through the provider's normal prompt path, so
 * provider permission behavior is unchanged.
 */
export async function spillLargePrompt(
  prompt: string,
  deps: PromptSpillDeps = {}
): Promise<PromptSpillResult> {
  if (!shouldSpillPrompt(prompt, deps)) {
    return { prompt, spilled: false, cleanup: noopCleanup };
  }

  const createTempDir = deps.createTempDir ?? (() => mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX)));
  const writeContextFile =
    deps.writeContextFile ??
    ((filePath: string, contents: string) => writeFile(filePath, contents, { mode: 0o600 }));
  const removeTempDir =
    deps.removeTempDir ?? ((directory: string) => rm(directory, { recursive: true, force: true }));

  let directory: string | undefined;
  try {
    directory = await createTempDir();
    const filePath = join(directory, CONTEXT_FILE_NAME);
    await writeContextFile(filePath, prompt);
    const createdDirectory = directory;
    return {
      prompt: buildPromptPointerMessage(filePath),
      spilled: true,
      cleanup: () => removeTempDir(createdDirectory),
    };
  } catch (error) {
    if (directory) await removeTempDir(directory).catch(() => undefined);
    deps.onError?.(error, prompt.length);
    return { prompt, spilled: false, cleanup: noopCleanup };
  }
}

/** Best-effort crash recovery for prompt directories left by an earlier runtime process. */
export async function cleanupStalePromptSpills(deps: StalePromptCleanupDeps = {}): Promise<void> {
  const listTempEntries =
    deps.listTempEntries ??
    (async () =>
      (await readdir(tmpdir(), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })));
  const statTempEntry = deps.statTempEntry ?? (async (name: string) => stat(join(tmpdir(), name)));
  const removeTempEntry =
    deps.removeTempEntry ??
    ((name: string) => rm(join(tmpdir(), name), { recursive: true, force: true }));

  try {
    const entries = await listTempEntries();
    await Promise.all(
      entries.flatMap((entry) => {
        if (!entry.isDirectory || !entry.name.startsWith(TEMP_DIR_PREFIX)) return [];
        return [
          (async () => {
            const metadata = await statTempEntry(entry.name);
            if ((deps.now?.() ?? Date.now()) - metadata.mtimeMs < STALE_PROMPT_AGE_MS) return;
            await removeTempEntry(entry.name);
          })(),
        ];
      })
    );
  } catch (error) {
    deps.onError?.(error);
  }
}
