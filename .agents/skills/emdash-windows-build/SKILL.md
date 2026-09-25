---
name: emdash-windows-build
description: Build, locally package, and launch Emdash on Windows after changing Emdash source, assets, configuration, or dependencies. Use for every Emdash change in a Windows checkout to verify the new build without touching the installed app or its profile.
compatibility: Native Windows, pnpm and Node from this repository, Git Bash or PowerShell
---

# Verify a Windows change by launching its build

After making changes, run `scripts/build-launch-windows.ps1` from this skill directory. It installs dependencies if missing, runs the root Nx build, creates an **unsigned, unpacked** Windows build, and opens `Chorus.exe` (or `Emdash.exe` on upstream checkouts) with a unique scratch user-data directory and database. It does **not** install over `C:\Program Files\Emdash`, publish, sign, or run release workflows. Do not use `package:win` for this local test: `electron-builder.config.ts` selects publisher-only Azure Trusted Signing.

From the repo root in Git Bash (or adapt to PowerShell):

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w .agents/skills/emdash-windows-build/scripts/build-launch-windows.ps1)"
```

The script prints the unpacked executable, scratch profile, process ID, and whether a main window opened. Leave the launched app open for the user. Before claiming success, check its window title/handle, profile database, and any warnings in its profile log. An unpacked build may log `app-update.yml` missing: it is not an installer and has no generated update metadata. The clean checkout also logged `notifications: prune failed` with `near "offset": syntax error`; report this warning if present. Report other errors rather than hiding them.

## Path with an apostrophe (including this checkout)

Vite can generate invalid import strings when the checkout is under `C:\Users\'admin'\...`; the resulting `packages/chat-ui/src/styles/global.css.ts` parse error is a path bug, not an app source error. **Never run the build in that path.** Keep the current checkout as the edit source and build a snapshot in a clean path (for example `C:/Github/emdash-win-build-<unique-id>`):

1. Inspect `git status --short` and `git diff HEAD --stat` in the source checkout. Create a *new*, detached scratch worktree at the current `HEAD` with `git worktree add --detach <clean-path> HEAD`. Never use the installed Emdash directory or an existing user's worktree. Ensure the scratch path has no apostrophe and is writable.
2. Bring source changes across: `git diff HEAD --binary > <scratch-parent>/emdash-changes.patch` then `git -C <clean-path> apply --binary <scratch-parent>/emdash-changes.patch` if the patch is nonempty. This includes staged and unstaged changes to tracked files but **not** untracked files. Inspect `git ls-files --others --exclude-standard` and manually copy only relevant new source/config files into matching scratch paths. Do not copy secrets, databases, logs, `node_modules`, or generated build outputs. Verify the scratch diff matches the intended change.
3. Run the skill's script from the *original* checkout with `-RepoRoot <clean-path>`; the script will build the scratch snapshot, not the original checkout:

   ```bash
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w .agents/skills/emdash-windows-build/scripts/build-launch-windows.ps1)" -RepoRoot 'C:/Github/emdash-win-build-<unique-id>'
   ```

4. Keep the scratch worktree/output while its app is running. When finished and after closing only that test app, clean up with `git worktree remove <clean-path>` (use `--force` only after reviewing any scratch-only files), and delete only the named scratch output/profile. Never delete the source checkout or installed app.

Use a new scratch worktree or refresh the snapshot after later edits so you do not accidentally test a stale build. A normal path may be built directly. If `pnpm run doctor` fails **only** because Playwright Chromium is missing, packaging is still possible; browser tests need `pnpm exec playwright install`. Other doctor failures, especially the Electron ABI probe, need fixing before trusting the result.

Windows packaging failed to rename `win-unpacked.tmp` with `EPERM` when output was under `apps/emdash-desktop/release/`; packaging outside the checkout succeeded. The script always uses a fresh sibling output directory. If it still fails, retry with a fresh output directory, not by disabling protection. Never work around unsigned-package signing errors by modifying the release config: the script uses a temporary config that removes only `win.azureSignOptions` and deletes it afterward. Preview via `pnpm exec electron-vite preview` from `apps/emdash-desktop` is a faster alternative after a successful build, but it is **not** a packaged-EXE test; always isolate it with `EMDASH_USER_DATA_DIR` and `EMDASH_DB_FILE`.

If this environment cannot execute Windows commands, report that verification was not run. Do not claim success from reading files alone. Pi on native Windows should point `shellPath` at Git Bash (for example `C:/Program Files/Git/bin/bash.exe` in `~/.pi/agent/settings.json`) or enable its PowerShell tool; a WSL `/bin/bash` failure is a runner problem, not a build failure.
