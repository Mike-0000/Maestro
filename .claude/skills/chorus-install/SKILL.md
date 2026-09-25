---
name: chorus-install
description: Build a Chorus installer from C:\Github\chorus and install it over the user's installed Chorus app (%LOCALAPPDATA%\Programs\Chorus), then relaunch it. Use when the user asks to push, ship, deploy, or install changes to their installed Chorus, or to roll the installed app back to an earlier build.
compatibility: Native Windows PowerShell, pnpm and Node from this repository
---

# Install a Chorus build over the installed app

Chorus is this fork of Emdash. The installed copy lives in `%LOCALAPPDATA%\Programs\Chorus`
(originally a per-user NSIS install) and keeps its data in `%APPDATA%\chorus` (the installer never touches it).
`apply-install.ps1` backs that profile up (minus Chromium caches) to
`chorus-releases\<build>\userdata-backup-<time>\` before every install and aborts if it cannot.
Never change `USER_DATA_DIR_NAME` in `app-identity.ts`: a new name means an empty profile. The
app imports the pre-rebrand `%APPDATA%\emdash` profile once on first launch (marker
`.chorus-profile-import.json`, prior profile saved to `chorus.pre-import-backup-<time>`).
`pnpm run dev` uses `%APPDATA%\chorus-dev`, so dev runs never share data with the installed app.
This is a local install only: never publish, upload, sign, or run release workflows.

## Steps

1. **Commit first.** Build from `C:\Github\chorus` or a task worktree under
   `C:\Github\chorus-worktrees` (never under `C:\Users\'admin'\...`: Vite cannot build from a
   path with an apostrophe, and the script refuses one). The script refuses uncommitted tracked
   changes unless given `-AllowDirty`, so every installed build maps to a commit. Run the focused
   tests and `pnpm run typecheck` for the change before shipping. Installing from a task worktree
   ships that branch as-is; to ship integrated work, merge into `chorus/main` and build from
   `C:\Github\chorus`.
2. **Check whether you are running inside Chorus.** Walk your process's parent chain (e.g.
   `Get-CimInstance Win32_Process` by `ParentProcessId`). If a `Chorus.exe` is an ancestor,
   quitting Chorus ends this session and every agent running in it.
3. **Build and schedule the install:**

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Github\chorus\.claude\skills\chorus-install\scripts\install-chorus.ps1 -RepoRoot C:\Github\chorus
   ```

   From a worktree, run that worktree's copy of the script; `-RepoRoot` defaults to the checkout
   the script lives in.

   It runs `pnpm run build` (Nx-cached, so unchanged packages are skipped), packages the unpacked
   app (`electron-builder --win dir`, no NSIS installer) into
   `C:\Github\chorus-releases\<timestamp>-<sha>\win-unpacked\` (with `build-info.txt`), then
   starts `apply-install.ps1` through WMI so it survives Chorus quitting. By default the helper
   **waits for the user to quit Chorus** (up to 12 h), backs up the profile, mirrors
   `win-unpacked` into the install directory with `robocopy /MIR` (keeping
   `Uninstall Chorus.exe`, so Apps & Features uninstall still works), checks that
   `resources\app.asar` matches the build, and relaunches Chorus. Only the newest 3 unpacked
   builds are kept (`-KeepBuilds`); older folders keep their logs and profile backups.
   - `-CloseRunning` closes Chorus immediately instead. Use it only when the user explicitly asks
     for that, knowing it ends their running agents (and this session, if hosted in Chorus).
   - `-BuildOnly` stops after packaging.
   - `-AppDir <chorus-releases\<build>\win-unpacked>` skips the build and installs that build
     (rollback).
   - `-Installer` builds and installs through an NSIS installer instead (about a minute slower);
     `-InstallerPath <exe>` installs an existing installer.
4. **Tell the user** to quit Chorus fully (all windows, and the tray icon if any) when ready. The
   result is logged to `install.log` in the build folder; read it on the next session to confirm
   `installed` and `relaunched Chorus; done`, or report the `FAILED:` line.

## Notes

- The version stays `1.2.6` unless bumped in `apps/emdash-desktop/package.json`; reinstalling
  the same version is fine.
- Builds are unsigned (no Chorus signing identity yet), so SmartScreen may warn on a manual run.
  The auto-updater is disabled (`UPDATES_ENABLED = false`), so the installed app only changes
  through this skill.
- The older installer at `C:\Github\chorus-installer\chorus-x64.exe` (commit `24a9df677`) predates
  this skill and can serve as a rollback target.
- For a quick packaged test that leaves the installed app alone, use
  `.agents/skills/emdash-windows-build` instead.
