# Running projects in WSL2

On Windows, Maestro can run whole projects inside a WSL2 distro: the repository, every task's
worktree, git, the terminals and the agents all live and run on the distro's Linux filesystem.
That is where WSL2 is fast, and parallel agents gain the most, because nothing they read,
search or install crosses the Windows boundary.

## The quick way: Run in WSL

Right-click a project in the sidebar and choose **Run in WSL**. It is offered for projects on
a Windows drive. The project's folder on Windows stays where it is and stays usable: the
project gets a copy on the distro's own disk, where the agents run at full speed, and a live
mirror keeps the two the same from then on (see [The live mirror](#the-live-mirror)). One
click does all of this, and a message afterwards lists what was done:

- **A distro.** If the computer has no WSL2 Linux distro, Ubuntu is installed, with a user
  named after your Windows user. This needs WSL itself to be enabled already; if it is not,
  the message says to run `wsl --install` once.
- **git in the distro.** git and tmux are installed if missing (Ubuntu and Debian). Your git
  name and email are copied from Windows if the distro has none. If Git for Windows is
  installed, git in the distro signs in through its Credential Manager, so HTTPS remotes use
  the logins you already have. Nothing you set yourself in the distro is changed.
- **Claude Code in the distro.** Installed if missing.
- **The repository.** Cloned from the Windows folder into `~/emdash/repositories/<name>` in the
  distro, with its remote set to the same URL.
- **The mirror.** Started between the Windows folder and that copy. Its first run makes the
  copy match the Windows folder exactly, uncommitted and untracked work included; the project
  opens when that is done. Running the action again reuses the copy and the mirror.
- **The project.** The distro is added as a machine and the copy opens as `<name> (WSL)`. The
  Windows project is left as it is, and both show the same files.

Installed packages and build output are not mirrored, so install dependencies in the distro
once (for example `pnpm install` in a terminal on the WSL project).

What is left for you, when it applies, is in the message: signing in to Claude in the distro
once (open a terminal on the WSL machine and run `claude`), and adding an SSH key when the
remote uses SSH. Your Claude sign-in on Windows is not copied: two installs sharing one
sign-in can log each other out.

## The live mirror

A mirror keeps one Windows folder and its copy in a distro the same, both ways, for as long
as Maestro runs. Neither side reads the other's disk while it works: each has real files on
its own filesystem, so Linux tools are fast in the distro, Windows tools are fast on Windows,
and file watchers work on both.

**What is mirrored**

- Every file git does not ignore, tracked or not, within about a second of a change. Edits,
  new files, deletions and renames all carry over.
- Git state: commits, branches, tags, remote-tracking refs and the checked-out branch. A
  commit made in the distro is a commit on Windows a moment later, and `git status` reads the
  same on both. Each side keeps its own `.git`; only commits and ref values cross, through git
  itself, so the two can never corrupt each other. Staging is per side.
- A few ignored files a project needs on both sides: `.env`, `.env.*`, `.envrc`, `.mcp.json`,
  `.claude/settings.local.json`, `.vscode/settings.json`, and anything the project lists in
  `preservePatterns` in `.emdash.json`.

**What is not**

- Everything else git ignores, and `node_modules` always. Installed packages and build output
  are specific to each system, so each side keeps its own.
- Symbolic links. The copy is set to check them out the way git on Windows does.
- Stashes, and operations in progress (a merge or rebase): finish those on the side they were
  started on. While one is in progress git state waits; files keep flowing.

**When both sides change the same thing**

- *A file*, edited on both sides before the mirror could carry either edit: the newer one is
  kept on both sides and the other is moved to `.git/maestro-mirror/trash/<time>/` on the side
  it came from. Deleted files go there too. The trash is emptied after a week.
- *A branch*, committed to on both sides (this takes the mirror being paused or the app being
  closed): neither side is changed. Each gets the other's commits as
  `refs/maestro-mirror/conflict/heads/<branch>`; merge that on one side and the mirror
  carries the result over.
- Editing a file on one side while it was deleted on the other keeps the file.
- *A file that cannot cross* (a name Windows cannot hold, two names in the distro that differ
  only in case, a file another program keeps locked) is left where it is and listed as a
  conflict after a few tries. It is tried again every few minutes; everything else stays in
  sync meanwhile.

**The first run.** The Windows folder is the truth once: the copy is made to match it, and
anything replaced or removed in the copy is moved aside, never destroyed. That holds for a
single pass. From then on both sides are equals, so work an agent starts in the distro while a
few files are still catching up is never undone. A branch that has different commits in an
existing copy is not overwritten either; it is reported like any other diverged branch.

**Safety**

- Nothing is deleted on one side unless the file is really gone from the other.
- If one side is suddenly empty (a reset distro, a missing drive), the mirror stops with an
  error and changes nothing.
- A file held open on Windows is retried until it can be replaced.
- Changes made while Maestro is closed, deletions included, carry over at the next start.

**Controls.** Right-click either project: the menu shows the mirror's state, **Pause WSL
mirror** / **Resume WSL mirror**, and **Stop WSL mirror**, which ends it and leaves both
folders as they are. Mirrors are remembered across restarts.

**How it works.** The same small program runs on each side (a thread in Maestro; a Node
process in the distro, run by the workspace server's Node). Each watches its own folder and
reports changes. Maestro compares both against the state they last agreed on, and has the
distro side carry file contents across the drive mount into a temporary file, which the
receiving side checks and renames into place. Only single changed files ever cross the
Windows boundary, never the tools working on them.

## Add the distro as a machine

Settings → Machines → **Add WSL distro**. The button is shown on Windows. It adds the next WSL2
distro that is not a machine yet, the default distro first; Docker Desktop's own distros are
left out. The machine is named `<distro> (WSL)`.

Then create or clone a project **on that machine**, the same way as on an SSH machine. Its
files go under the distro's home (`~/emdash/…` by default, or the machine's worktree root).
A project that already lives on a Windows drive stays a Windows project: use **Run in WSL** to
run it in the distro with a live mirror, or clone it onto the WSL machine for a separate copy.

## What the distro needs

- **WSL2**, with network access, `curl` or `wget`, `tar`, `sha256sum`, and glibc. A stock Ubuntu
  has all of them.
- **git**, and **tmux** if you want agent sessions to survive Maestro restarting.
- **The agent CLIs inside the distro**, signed in there. For Claude Code:
  `curl -fsSL https://claude.ai/install.sh | bash`, then `claude` once to sign in. The distro's
  `~/.claude` is separate from the one on Windows.
- **git credentials inside the distro** (an SSH key or a credential helper). Maestro's managed
  credential helper is for this computer's own projects only.

## How it works

The distro is a machine like an SSH host, reached without SSH:

- Commands run as `wsl.exe -d <distro> --cd ~ --exec /bin/sh -c <command>`. The command is one
  argument that `wsl.exe` passes on untouched, so nothing is re-quoted on the way.
- Windows directories are taken off `PATH` first. Otherwise the distro would find Windows
  programs (`git.exe`, a Windows `claude`) and every lookup would cross the drive mount.
- Maestro installs its workspace server in the distro on first connect
  (`~/.emdash/workspace-server`), downloaded by the distro itself, and starts it as a background
  process there. It keeps running between connections; reconnecting takes under a second.
- The connection to it is a small relay inside the distro whose input and output carry the
  protocol, because a socket in the distro cannot be opened from Windows.
- Preview servers are reached on `localhost`, which WSL maps to the distro.

## Limits

The same things that are off for SSH machines are off here:

- Maestro's per-session MCP tools (browser tools, conductor requests, `show_markdown`).
- The managed git credential helper and the Markdown viewer.
- Conductor code checks, except on a project made with **Run in WSL**: a check reads its Windows
  copy, which the live mirror keeps the same apart from files git ignores. The conductor's
  lookup by name (`find_in_project`) works on every WSL project.
- "Show in folder" and "Open with the default app". **Open in VS Code / Cursor** works, through
  their WSL remote.

Also:

- The workspace server in the distro is the published build for this protocol version, not
  built from this checkout. Features that exist only in the desktop app are unaffected.
- The workspace server reads the distro's login environment when it starts. An agent CLI
  installed afterwards is not found until the server restarts: disconnect and reconnect the
  machine after `~/.emdash/workspace-server/current/bin/emdash-workspace-server stop --socket
  ~/.emdash/workspace-server/run/workspace.sock`, or run `wsl --terminate <distro>`.
- A distro that WSL shuts down takes its workspace server with it; Maestro starts it again on
  the next connect. Agent sessions inside tmux survive a Maestro restart, not a distro shutdown.

## What was tested

Against a real Ubuntu distro: command quoting, starting directory, `PATH`, scripts on stdin, a
missing socket, and the whole path from a cold distro (install, start, protocol handshake, a
file-system call) and from a warm one. Run them with
`EMDASH_TEST_WSL_DISTRO=<distro> pnpm exec vitest run --project node src/main/gateway/workspace-server.wsl.test.ts src/core/services/ssh/node/local`.

The live mirror, against the same distro: a first run on a repository with uncommitted work
and ignored files, edits each way, a deletion, a script made on Windows run in the distro, a
commit made in the distro arriving on Windows, and a branch made on Windows being checked out
in the distro, with `git status` matching on both sides throughout. Run it with
`EMDASH_TEST_WSL_DISTRO=<distro> pnpm exec vitest run --project node src/core/services/wsl-mirror`.
A first run on this repository (5,829 mirrored files) took 8 seconds.

Not tested: an agent session in the distro driven from the app's own window, a project created
through the UI (the **Run in WSL** menu action included), and preview servers.

## The older per-agent switch

Settings → Agents → Claude Code → Advanced settings → **Run in WSL2** starts only Claude's
terminal process in the default distro while the project stays on the Windows drive. It does
not make anything faster, since every file access then crosses into Windows, and it has never
been run in a real session. Prefer a WSL machine.
