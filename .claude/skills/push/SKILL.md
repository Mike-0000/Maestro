---
name: push
description: Ship finished Maestro (Chorus) work by publishing one signed release to the Azure auto-update feed, so every install, including this computer, gets it through Download and Restart. Use when the user says /push, or asks to push, push the install, ship, release, deploy, or update their installed Maestro or Chorus. Works from the project directory (C:\Github\chorus, the default agent workspace) or from a task worktree. One script checks the change, builds the installer, promotes chorus/main, and publishes, in about four minutes.
compatibility: Windows, C:\Github\chorus, Node 24 and pnpm, Azure CLI signed in
---

# /push: check, build, and publish Maestro

The user has standing approval for this whole flow, including publishing the release to the
Maestro auto-update feed. Do every step without asking.

This computer is an ordinary Maestro client. It updates like every other machine: the app finds
the new release on the Azure feed, and the user chooses **Download**, then **Restart**. `/push`
only publishes. It never installs anything here.

Never do any of these, even if an older doc or skill says to:

- `git push` (the only remote is the public upstream project)
- schedule a local install or rollback from the Local Chorus update card or the voice agent
- run `maestro-x64.exe`, `install-chorus-update.ps1`, or the old `chorus-install` scripts
- touch `%LOCALAPPDATA%\Programs\Chorus*`, `%LOCALAPPDATA%\Programs\Maestro`, or the profile
- close, kill, or restart Maestro on the user's behalf

Pick the mode from where you are working:

- **Project directory** (`C:\Github\chorus`, on `chorus/main`): the default. Other agents may be
  editing the same directory at the same time.
- **Task worktree** (under `C:\Github\chorus-worktrees\...`): only when you were spawned with a
  separate worktree.
- **Release only**: `chorus/main` already holds the work (for example the app promoted it) and
  it only needs publishing.

## Project directory mode

Do **not** commit, stage, stash, reset, or switch branches in `C:\Github\chorus`. The index and
working tree are shared with other agents. The script snapshots your files into a commit off to
the side, and promotion brings `chorus/main` up to it without touching anyone else's edits.

1. **Know your files.** List every path you created, modified, or deleted in this task, relative
   to the repo root. Include only your own work. Another agent's half-finished edit in a file you
   list will ship with yours. Check with `git status --short` and `git diff -- <path>`.
2. **Run the focused tests for what you touched.** Do not run typecheck, lint, or format by hand
   first. The script runs all three on exactly the files you list, and a failure costs about two
   minutes, not a rebuild.
3. **Push in one background command**, started last:

   ```powershell
   node "C:\Users\'admin'\.claude\skills\push\scripts\push.mjs" --message "<type>(<scope>): <summary>" -- <path> <path> ...
   ```

   The message is a Conventional Commit and becomes the pushed commit's message. Pass `--all`
   instead of a path list only when the user says to ship everything in the directory.
4. Don't edit the files you pushed while it runs. If one of them changes on disk before promotion,
   promotion refuses rather than overwrite it, and nothing is published.

## Task worktree mode

1. Run the focused tests for what you touched.
2. Commit with Conventional Commits. `git add` only your files; never the stray `%SystemDrive%`
   folders. The worktree must be fully clean, including untracked files.
3. Rebase onto `chorus/main` if it has moved (`git merge-base --is-ancestor chorus/main HEAD`),
   then push in one background command, started last:

   ```powershell
   node "C:\Users\'admin'\.claude\skills\push\scripts\push.mjs" --worktree <worktree>
   ```

   A worktree that Chorus did not create (an SSH-project task, or one made by hand with
   `git worktree add`) is not enrolled with the coordinator, and `identify` fails. Enroll it once
   with `coordinator.join` (see the `chorus-push-unenrolled-worktree` memory). A hand-made
   worktree has no Chorus task, so use the local project id
   `97cf8580-8b59-4ae4-827a-c75561afb017` and a task id named after the branch.

## Release only

```powershell
node "C:\Users\'admin'\.claude\skills\push\scripts\push.mjs" --release-only
```

It publishes `chorus/main` (or `--commit <sha>`). If that commit is already the published release
(`%LOCALAPPDATA%\Chorus\UpdateBuilds\last-release.json`), it only prints the link; `--force`
republishes.

## What the script does

Run it with `run_in_background`. It takes about four minutes and prints each step with its
duration. It runs as one process on purpose:

1. It checks the signing key and starts the Azure sign-in check, then takes the push lock. A
   second push waits for the first.
2. It snapshots your paths (directory mode), enrolls the snapshot with the delivery coordinator,
   and integrates it on top of `chorus/main`.
3. It checks out the integrated commit in the persistent release worktree
   `C:\Github\chorus-worktrees\maestro-release`. That worktree keeps `node_modules` and build
   caches, and `pnpm install` runs only when a manifest or the lockfile changed. Never edit or
   ship from that worktree.
4. It builds the app bundles, then runs format, lint, typecheck, and the delivery tests in
   parallel with the installer build.
5. Only when the installer exists and every check passed, it promotes `chorus/main`. In directory
   mode your files then show as committed, and other agents' edits stay uncommitted.
6. It signs the manifest, uploads the release, points `<feed>/Maestro-Setup.exe` at the new
   installer, and copies it to `%USERPROFILE%\Downloads\Maestro\Maestro-Setup-<version>.exe`.
   It keeps the two newest builds in `%LOCALAPPDATA%\Chorus\UpdateBuilds`.

Flags: `--dry-run` checks, builds, and signs, but promotes and uploads nothing (use it to test
the pipeline). `--notes "<text>"` overrides the release notes, which default to the commit
subjects since the last release. The version is `<package version>-maestro.<UTC yyyymmddHHMM>`.

`ship.mjs` and `release.mjs` still exist and forward to `push.mjs`, so an old
`ship.mjs ... && release.mjs` command does one push.

Feed details: storage account `stmaestroupdd5313e`, resource group `rg-maestro-updates`,
container `maestro`, feed `https://stmaestroupdd5313e.blob.core.windows.net/maestro`. The design
is in `docs/chorus/auto-update.md` in the repo.

## Report

The script ends with `published: {version, commit, installer, local}` and `done: total <time>`.
Tell the user the commit, the published version, the total time, the download link
`https://stmaestroupdd5313e.blob.core.windows.net/maestro/Maestro-Setup.exe`, and the local exe
path. Then tell them: every Maestro, including this computer, finds the update within an hour, or
30 seconds after the next launch, and they can also check in Settings. They choose **Download**,
then **Restart**.

If this computer never shows the update, it is running an old unpacked build with no
`resources\app-update.yml`. Tell the user to install the latest release once from the download
link. Do not run the installer for them.

To undo a bad release, fix the problem and push again. Installed apps never downgrade.

## When it fails

The script ends with `push: FAILED after <time>: <reason>`. Nothing is promoted or published
unless the failure is in the publish step itself. Step logs, with a timestamp on every line, are
in `%LOCALAPPDATA%\Chorus\Delivery\v1\Logs\<candidate>\<step>.log` (release-only:
`%LOCALAPPDATA%\Chorus\UpdateBuilds\logs\<time>\`). Steps: `install`, `packages-build`,
`app-build`, `remote-web-build`, `static-check`, `delivery-tests-desktop`, `delivery-tests-wire`,
`installer`, `publish-maestro-update`.

- **`static-check` or a test step failed**: a real format, lint, typecheck, or test failure.
  Fix it and push again. In directory mode your files are still uncommitted edits; fix them in
  place. In worktree mode, commit the fix first.
- **`The listed paths match chorus/main`**: nothing you listed differs from `chorus/main`. Check
  the path list.
- **`local edits to <paths> that promotion would overwrite`**: someone changed a pushed file on
  disk during the build. Nothing moved and nothing was published. Push again once it settles.
- **`Could not create an upload SAS`**: the Azure sign-in lapsed (90 days idle). Ask the user to
  run `! az login --tenant bbc3b382-8ea0-4893-aa0d-44fc817b7640`, then push again. If they are
  signed in, the account needs *Storage Blob Data Contributor* on `stmaestroupdd5313e`.
- **`No update signing key`**: **never regenerate it.** A new key would lock out every installed
  copy. Ask the user to restore it from their backup.
- **`Submission base must match ... enrollment`** or **the candidate is ineligible**: something
  changed the candidate's tasks mid-run. Push again.
- **`installer` failed with `EPERM` renaming `win-unpacked.tmp`**: a build folder landed under
  the checkout's `release/` folder. Builds belong in `%LOCALAPPDATA%\Chorus\UpdateBuilds`.
- **`missing runtime dependencies from app.asar`**: electron-builder collected `node_modules`
  with the wrong package manager. The script sets `npm_config_user_agent` for the build; keep
  it. An installer built without it fails on launch with `Cannot find package 'zod'`.
- **`The feed already serves <version>`** or **`already exists with different contents`**: wait
  a minute and push again; the next minute gives a new version.
- **Failed after `promote`**: `chorus/main` moved but the release is not out. Run
  `push.mjs --release-only` once the cause is fixed.

## Keeping the packaged app small

The installer build is fast because only packages the main process loads at runtime are
`dependencies` of `apps/emdash-desktop`. Workspace packages (`@emdash/*`) and renderer-only
libraries are bundled by Vite, so they belong in `devDependencies`. A package in `dependencies`
is copied into `app.asar` with everything it depends on.
