# Running projects in WSL2

On Windows, Maestro can run whole projects inside a WSL2 distro: the repository, every task's
worktree, git, the terminals and the agents all live and run on the distro's Linux filesystem.
That is where WSL2 is fast, and parallel agents gain the most, because nothing they read,
search or install crosses the Windows boundary.

## Add the distro as a machine

Settings → Machines → **Add WSL distro**. The button is shown on Windows. It adds the next WSL2
distro that is not a machine yet, the default distro first; Docker Desktop's own distros are
left out. The machine is named `<distro> (WSL)`.

Then create or clone a project **on that machine**, the same way as on an SSH machine. Its
files go under the distro's home (`~/emdash/…` by default, or the machine's worktree root).
A project that already lives on a Windows drive stays a Windows project: move it by cloning it
onto the WSL machine.

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
- The managed git credential helper, conductor code checks, and the Markdown viewer.
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

Not tested: an agent session in the distro driven from the app's own window, a project created
through the UI, and preview servers.

## The older per-agent switch

Settings → Agents → Claude Code → Advanced settings → **Run in WSL2** starts only Claude's
terminal process in the default distro while the project stays on the Windows drive. It does
not make anything faster, since every file access then crosses into Windows, and it has never
been run in a real session. Prefer a WSL machine.
