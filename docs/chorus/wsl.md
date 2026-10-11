# Running Claude Code in WSL2

On Windows, Maestro can start Claude Code's terminal sessions inside WSL2 instead of as native
Windows processes. It is off by default.

Turn it on in Settings → Agents → Claude Code → Advanced settings → **Run in WSL2**. The switch
is shown only on a Windows machine, for the local host.

## What you need

- A WSL2 distro that is your **default** one (`wsl --set-default <name>`). Docker Desktop's own
  distro does not count.
- Claude Code installed in that distro and on the login shell's `PATH` (`sh -lc 'command -v
  claude'` must print a path), and signed in there. The distro has its own `~/.claude`, separate
  from the one on Windows.
- Claude Code also installed on Windows. Maestro still finds the agent through the Windows
  install; only the launch goes through WSL.
- Windows interop on in the distro (the default), so the distro can run `cmd.exe` and
  `powershell.exe`. Maestro's status hooks depend on it.

## What happens

- Before a session starts, Maestro asks the default distro for `claude`. When it answers, the
  session runs as `wsl.exe --exec sh -lc "claude …"` in the task's folder, which the distro sees
  under `/mnt/<drive>/…`.
- When there is no such distro, or WSL does not answer within 15 seconds, the session starts
  on Windows exactly as with the switch off. The log says why. The answer is kept for a minute.
- Paths Maestro passes on the command line (the MCP configuration, a long prompt written to a
  file) are translated. The variables the agent needs are named in `WSLENV`; variables that
  describe Windows (`PATH`, `HOME`, `USERPROFILE`, …) are not forwarded.
- Maestro installs its status hooks into the distro's `~/.claude/settings.json`. They are the
  Windows hook commands: the distro runs them through interop, and they report to Maestro on
  the Windows loopback address.

## What does not work yet

- **Chat (ACP) sessions** always run on Windows.
- **Maestro's per-session MCP servers** (browser tools, conductor requests, `show_markdown`)
  listen on the Windows loopback address. A Linux process reaches that only with WSL's mirrored
  networking (`networkingMode=mirrored` in `.wslconfig`). Without it Claude reports those
  servers as unreachable and everything else works.
- **Workspace trust** is not written for you; Claude asks once per folder in the distro.
- **Shell setup** from the host or project settings is a `cmd.exe` line and is not run in the
  distro. Put what the agent needs in the distro's `~/.profile`.
- **A named distro.** Only the default distro is used.
- **Sessions started on Windows** cannot be resumed in WSL, or the other way round: each side
  keeps its own session files.
- File paths the agent prints are `/mnt/c/…` paths; links made from them may not open.

This path was built without a WSL distro to test against. The command line, the path and
variable handling, and the fallback are covered by unit tests; a real session in a distro has
not been run.
