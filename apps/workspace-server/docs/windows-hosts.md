# Windows Remote Hosts

Chorus can use a Windows 10 1809+ / Windows Server 2019+ x64 machine (or Windows 11 on ARM, under
x64 emulation) as a remote host over the built-in Windows OpenSSH server. The desktop side, the
install script, the daemon, and the transport each have a Windows path; this page is the map.

Setting up the remote machine (installing and starting `sshd`, opening port 22, authorized keys)
is the machine owner's job. Chorus never changes remote services or firewall rules; the machine
form shows the setup steps under "Connecting to a Windows machine?"
(`apps/emdash-desktop/src/core/features/machines/browser/windows-host-setup-help.tsx`).

## Platform Detection

`probeRemotePlatform` (`apps/emdash-desktop/src/core/primitives/ssh/api/node/remote-platform-probe.ts`)
first runs `uname -s`. A POSIX answer (other than Cygwin/MSYS/MINGW kernels) selects the existing
POSIX path. Otherwise it runs `WINDOWS_PLATFORM_PROBE_SCRIPT`
(`apps/emdash-desktop/src/core/primitives/ssh/api/remote-platform.ts`), which reports the
PowerShell language mode, `USERPROFILE`, native architecture, OS build, PowerShell version, and
the Git path.

`evaluateRemotePlatform` turns those facts into actionable issues. Errors block installation:
ConstrainedLanguage mode, missing profile, PowerShell older than 5.1, Windows older than build
17763, 32-bit or unknown architectures, and ARM64 before Windows 11. Missing Git is a warning.
Test Connection shows the detected platform and every issue; provisioning throws the blocking ones.

## Command Transport

Windows OpenSSH starts commands with the account's default shell (`cmd.exe` unless changed), so no
POSIX quoting may reach it. Every Windows control command is
`powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand <base64>`
built by `formatPowerShellEncodedCommand`
(`packages/core/src/primitives/exec/api/windows-invocation.ts`). The base64 payload (UTF-16LE)
contains only `[A-Za-z0-9+/=]`, so it passes unchanged through `cmd.exe`, PowerShell, or bash
default shells. Values reach scripts only as `powerShellLiteral` single-quoted literals, never as
concatenated command text. `decodePowerShellStderr` turns CLIXML error records into plain text so
failures stay readable. Scripts live in
`apps/emdash-desktop/src/core/services/hosts/node/workspace-server/windows-scripts.ts`.

## Layout

`windowsWorkspaceServerLayout` mirrors the POSIX layout under
`%USERPROFILE%\.emdash\workspace-server`:

```text
versions\<version>\   extracted artifact
current               text file naming the selected version (no symlinks)
staging\              downloads and extraction in progress
run\workspace.sock    endpoint record naming the daemon's named pipe
install.lock\         installer lock directory holding the installer pid
```

No step needs administrator rights.

## Installation

Maestro ships the `win32-x64` artifact, its `.sha256` sidecar, and `install.ps1` inside the desktop
app (`resources/workspace-server/`, prepared at build time by
`apps/emdash-desktop/scripts/prepare-workspace-server-bundle.ts`). When that bundle is present,
Windows hosts install its version and never read a release channel, so they work without a hosted
workspace-server release:

1. Skip everything if `current` already selects the bundled version.
2. Stream the archive to `staging\bundle-<uuid>\<version>\<artifact>` and `install.ps1` to
   `staging\install-<version>-<uuid>.ps1`. Each upload is an exec channel running an encoded
   script that reads exactly the declared byte count from stdin and verifies the SHA-256 before
   renaming the file into place (exit 41 otherwise). The exec channel is used instead of SFTP,
   which administrators often disable.
3. Run the installer with `-BaseUrl` set to the staging directory's `file:` URI and an explicit
   `-Sha256`, then delete the installer and the staged bundle. A failed upload also cleans them up.

A desktop build without the bundle (for example one packaged on a non-Windows host) falls back to
the release channel: the desktop reads the channel pointer, then runs two SSH commands:

1. Download the immutable `<version>/install.ps1` into
   `staging\install-<version>-<uuid>.ps1`.
2. Run that file with a process-scope `-ExecutionPolicy Bypass`.

Chorus never pipes a downloaded script into `Invoke-Expression`: antivirus products (Defender's
AMSI rules) block download-and-execute one-liners. A machine-wide `AllSigned` Group Policy still
applies to the downloaded file and blocks the install with a clear error.

`install.ps1` keeps `install.sh`'s exit codes (40 unsupported platform, 41 download or checksum
failure, 42 install failure). It verifies the `.zip` against its `.sha256` sidecar, extracts with
.NET `ZipFile`, and moves the version into place before atomically replacing `current`. A complete
existing version is never rebuilt. `scripts/install-ps1.test.ts` exercises it against a `file://`
mirror on Windows.

## Daemon

Windows OpenSSH puts each session's processes in a job object that is closed with the session,
and a Node `detached` spawn does not leave it. `start` therefore asks WMI (`Win32_Process.Create`)
to launch the internal `daemonize` command, which spawns the detached `serve` process with output
sent to the daemon log (`apps/workspace-server/src/daemon/windows-launch.ts`). The launch script is
constant; the command line reaches it only through environment variables.

Node listens on named pipes, not Unix sockets, on Windows. The daemon listens on
`\\.\pipe\emdash-workspace-server-<uuid>` and writes that name into the endpoint record at the
well-known socket path (`apps/workspace-server/src/daemon/endpoint.ts`). The random name prevents
another local account from squatting a predictable pipe. `stop` terminates the whole process tree
with `taskkill /T /F`, so workers, PTYs, and agents are not orphaned, then removes the record.

The artifact runs as `node.exe dist\index.mjs` without a launcher script, so the server reads its
version from `manifest.json` and ripgrep from `bin\rg.exe` (`apps/workspace-server/src/artifact.ts`).

## Connection

Windows OpenSSH does not forward Unix sockets. The desktop opens an exec channel running the pipe
bridge script (`connect/windows-pipe-bridge.ts`), which reads and validates the endpoint record,
connects to the pipe, prints `emdash-workspace-bridge-ready` on stderr, then relays bytes between the
channel and the pipe. The desktop treats the channel as the Wire stream once the marker arrives. A
bridge that exits early surfaces its decoded diagnostic, not a silent close.

## Open In

`apps/emdash-desktop/src/main/host/remoteOpenIn.ts` recognizes drive-letter and UNC paths. Editor
URLs use `/C:/...` forms, and the terminal command starts an interactive PowerShell (profile
loaded) at `Set-Location -LiteralPath '<path>'` through `-EncodedCommand`.

## Packaging

The `win32-x64` target builds on `windows-latest` with the official Node `win-x64.zip`, ripgrep's
`x86_64-pc-windows-msvc` zip (checksum pinned in `scripts/package-helpers.ts`), and native
modules installed with the target Node. The archive is a `.zip` containing `node.exe`, `bin\rg.exe`,
and `bin\emdash-workspace-server.cmd` for manual use. `--verify` runs ripgrep and the daemon's
`start`/`status`/`stop` against the extracted artifact. The release workflow's
`verify-windows-install` job installs the built zip with `install.ps1` from a `file://` mirror
under Windows PowerShell 5.1 before `publish` may run.

## Limitations

- x64 artifacts only; ARM64 hosts rely on Windows 11 x64 emulation.
- Long paths beyond `MAX_PATH` depend on the machine's `LongPathsEnabled` policy and Git's
  `core.longpaths`.
- The daemon launch needs WMI (`Win32_Process.Create`) to be available to the user.
- `AllSigned` execution policy and ConstrainedLanguage mode block setup; Chorus reports them but
  cannot work around them.
- The workspace connection needs only SSH exec channels. Workspace preview port forwarding still
  needs `AllowTcpForwarding`, which Windows OpenSSH enables by default.
- Start warnings from the daemon are logged by the desktop, not shown in the UI.
- Open In detects Windows targets by path shape (drive letter or UNC), not by the probe.
