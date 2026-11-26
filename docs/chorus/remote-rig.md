# Remote rig: a Maestro host on a Linux VM, driven from Windows

This guide sets up a Maestro **host** on a Linux virtual machine (for example an Azure VM) and
drives it from a Windows PC in **client mode**. The VM runs your agents, terminals, previews and
scheduled tasks around the clock; the PC shows the ordinary Maestro window, and its traffic goes
to the VM over Tailscale.

- The host is an ordinary Maestro install, run headless under `Xvfb` by a systemd user service.
- The client is the same Maestro you already have on Windows, started with `--maestro-client`.
  It has its own profile and runs beside your local Maestro.
- Both ends must run **the same build**. A mismatch blocks the connection with a screen that says
  which side to update. See [Updates](#11-updates).

The files this guide uses live in the repository under `apps/emdash-desktop/scripts/host/`:
`install-maestro-host.sh`, `maestro-host-run.sh` and `maestro.service`. Copy that folder to the VM
(`scp -r apps/emdash-desktop/scripts/host <vm>:maestro-host`), or clone the repository there.

## 1. Prepare the VM

Ubuntu 22.04 or 24.04 LTS, x64, with a normal (non-root) user. Over SSH:

```bash
sudo apt update
sudo apt install -y git curl openssl python3 xvfb
sudo apt install -y libfuse2t64     # Ubuntu 24.04; on 22.04 the package is libfuse2
```

Install the tools your agents use, as that user: `git`, `gh`, `claude` and any other agent CLIs,
and your language toolchains. Sign them in over SSH now (`gh auth login`, `claude` and follow its
login), because the host has no screen to show a login page on. Log `claude` in with your Claude
account and leave `ANTHROPIC_API_KEY` unset, or agents bill the API instead of your plan.

Once the host runs, `./install-maestro-host.sh doctor` checks all of this the way the service sees
it. For a VM that only runs scheduled tasks, see [scheduled-task-host.md](scheduled-task-host.md).

## 2. Install Maestro

```bash
cd ~/maestro-host
chmod +x *.sh
./install-maestro-host.sh install
```

This downloads the current Linux release from the update feed
(`<feed>/v1-stable-linux.yml`, then the AppImage it names), checks it against the SHA-512 in that
manifest, and installs:

- `~/.local/share/maestro/Maestro.AppImage` (a fixed name, so self-updates replace it in place)
- `~/.local/share/maestro/maestro-host-run.sh` (the Xvfb wrapper)
- `~/.config/systemd/user/maestro.service`

To install an AppImage you copied over yourself: `./install-maestro-host.sh install --appimage <file>`.

On Ubuntu 24.04, unprivileged user namespaces are restricted by AppArmor, so Chromium's sandbox
cannot start. The AppImage detects this and adds `--no-sandbox` by itself; nothing to do. If you
prefer to keep the sandbox, install an AppArmor profile for the AppImage that allows `userns`.

## 3. Secrets on a headless machine

Maestro keeps tokens (provider accounts, push keys, browser cookies) encrypted with Electron's
safe storage, which on Linux asks a keyring. A headless service has none, so the wrapper passes
`--password-store=basic`: secrets are stored with a fixed key, which only protects against casual
reading. Rely on the VM's disk encryption (Azure encrypts managed disks at rest) and keep the
user account to yourself.

To use a real keyring instead, run `gnome-keyring-daemon` unlocked in the user session and set
`Environment=MAESTRO_PASSWORD_STORE=gnome-libsecret` in the unit (there is a commented line for
it). Decide before you sign anything in: switching later makes stored secrets unreadable.

## 4. Run it as a service

```bash
sudo loginctl enable-linger "$USER"     # keep user services running while you are logged out
```

Do not start the service yet; the next step edits its settings, which Maestro only reads at start.

## 5. Turn on remote access and full-access clients

```bash
./install-maestro-host.sh configure
systemctl --user enable --now maestro
```

`configure` edits `~/.config/chorus/remote-access.json` (it refuses while the service runs,
because Maestro rewrites that file):

- `enabled: true`: the remote-access listener, on `127.0.0.1:7462`
- `ownerAccess.enabled: true`: full-access ("owner") clients, Tailscale-only by default
- `hostUpdates.mode: "when-idle"`: the host installs updates by itself when idle
  (`configure --manual-updates` keeps `manual`)

When owner access is on, Maestro writes `~/.config/chorus/owner-setup.token` (mode 0600) at start.
`./install-maestro-host.sh status` shows the service, these settings and `tailscale serve`.

## 6. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 7462
tailscale serve status
```

Note the address it prints, `https://<vm>.<tailnet>.ts.net`. That is the address the client uses.
Install Tailscale on the Windows PC too and sign in to the same tailnet. **Do not enable Funnel**:
Funnel would publish the host on the internet, and owner access refuses Funnel requests anyway.

`tailscale serve` terminates HTTPS, adds `Tailscale-User-Login` (who you are on the tailnet) and
`X-Forwarded-For` (your tailnet address), and forwards to the loopback listener. With
Tailscale-only on, the host accepts an owner only with those headers, or on a direct loopback
connection. Keep the listener on `127.0.0.1`.

## 7. Get a pairing code

On the VM, with the service running:

```bash
./install-maestro-host.sh pairing-code
```

which is the same as:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $(cat ~/.config/chorus/owner-setup.token)" \
  http://127.0.0.1:7462/api/owner/pairing-code
```

It prints `{"code":"…","expiresAt":…}`. The code is single use and expires after a few minutes.
This endpoint answers only a direct loopback connection with the setup token; it refuses anything
that came through `tailscale serve` or another proxy, so run it on the VM itself.

## 8. Start the client on Windows

The client is the Maestro you already installed (`%LOCALAPPDATA%\Programs\Maestro\Maestro.exe`),
started with one switch:

```powershell
& "$env:LOCALAPPDATA\Programs\Maestro\Maestro.exe" --maestro-client
```

It opens a connection screen. Enter the host address (`https://<vm>.<tailnet>.ts.net`) and the
code. After it connects, open the connection menu (the host name in the title bar) and choose
**Create a shortcut**: that adds a "Maestro Client" shortcut to the Desktop and Start Menu that
starts the client directly next time.

- The client keeps its own profile in `%APPDATA%\chorus-client` (logs, the saved host, its token
  encrypted with Windows DPAPI). `--maestro-client=<name>` starts a separate client profile,
  for example for a second host.
- Your local Maestro keeps running beside it, untouched.
- While a client is attached, the VM closes its own (invisible) window so only one Maestro
  window drives the agents. A minute after the client disconnects, the VM reopens it, so its own
  conductor keeps handling agents while your PC is off.

## 9. First use

- **Projects:** add one by browsing the VM's folders (paths are the VM's, for example
  `/home/<you>/src/...`), or clone into it.
- **Agents:** start a terminal agent and a chat agent as usual. Files you drop into a terminal or
  chat are uploaded to the VM first.
- **Previews:** `localhost` in the browser pane means the VM, so a dev server the agent starts on
  the VM (`http://localhost:5173`) opens as is.

## 10. Create a schedule

**Automations → New**: pick the project, the schedule, the prompt, the agent and model, then:

- **Effort**: how hard the agent thinks (Claude's effort level), per automation.
- **Close when done**: the run ends the agent when it finishes, with a timeout after which it is
  closed anyway. The run history then shows `Finished and closed`.

Scheduled runs happen on the VM, so they run with your PC switched off.

## 11. Updates

Every release goes to the same feed for both platforms with the same version string: the Windows
installer (`v1-stable.yml`) and the Linux AppImage (`v1-stable-linux.yml`).

**Publishing (the developer's machine).** `/push` publishes both: Windows first, then the Linux
build of the same release (its Linux leg, which needs Docker Desktop running). To publish only the
Linux leg of the last release, or to retry it, run `push.mjs --linux-only`, or run the script
directly from `apps/emdash-desktop` on Windows:

```powershell
node --experimental-strip-types scripts/release/maestro-linux-release.ts            # build, then a dry run of the publish
node --experimental-strip-types scripts/release/maestro-linux-release.ts --publish  # build if needed, then publish
```

It reads the version and commit `/push` recorded
(`%LOCALAPPDATA%\Chorus\UpdateBuilds\last-release.json`), builds that commit as an x64 AppImage in
Docker (Docker Desktop; image `node:24-bookworm`), and signs and uploads it with the same key and
Azure sign-in as `/push`. Details and options: [auto-update.md](auto-update.md#linux-host-builds).

**The host** checks the feed 30 seconds after start and then hourly. With
`hostUpdates.mode: "when-idle"` it downloads a new release by itself and installs it once no
agent or chat has been working and no automation run has been starting for five minutes. Agents
that are waiting for you and open shells do not hold it back. It warns the client first; systemd
starts the new build, and the client reconnects by itself.

**The client** shows the usual update card; choose **Download**, then **Restart**. The client and
your local Maestro are one installation, so while the local Maestro runs, update from its window
instead (the client says so).

**If the builds differ**, the connection screen names both. **Update host** asks the VM to
update now, without waiting for idle; **Update this client** updates the PC. Between the Windows
publish and the Linux publish, a client that already updated sees this screen: publish the Linux
build, then choose **Update host**.

## 12. Security notes

- One full-access client at a time. A second one sees "busy" and can take over; the first is told
  it was replaced.
- A full-access client can do everything on the VM that you can. Revoke a lost device under
  **Settings → Remote access** in a client (it shows and manages the host's devices), or stop the
  service and remove its entry from `ownerDevices` in `remote-access.json`. Revoking closes its
  connection at once.
- Tailscale-only means the host accepts owners only through `tailscale serve` from a tailnet user
  (or on the VM's loopback). `ownerAccess.allowedLogins` narrows it to listed tailnet logins.
  Turning Tailscale-only off (`"tailscaleOnly": false`) admits owners through any tunnel that
  reaches the listener, protected by the token alone; avoid it.
- The host stores only a digest of each device token. The client stores its token encrypted with
  Windows DPAPI in its own profile.

## 13. Troubleshooting

| Symptom | What to check |
| --- | --- |
| The service does not start | `journalctl --user -u maestro -e`. `Xvfb is not installed`, a missing `libfuse.so.2`, or the AppImage path. `systemctl --user status maestro`. |
| `owner-setup.token does not exist` | Owner access is off or the service has not started yet: run `configure` with the service stopped, start it, wait a few seconds. |
| Pairing: "only accepts full-access clients over Tailscale" (HTTP 403 `tailscale-required`) | The request did not come through `tailscale serve`: use the `https://<vm>.<tailnet>.ts.net` address, not the VM's IP. `tailscale serve status` must show `/ proxy http://127.0.0.1:7462`. Identity headers are added only for tailnet users: a Windows PC logged in as a **tagged** device gets none, so log it in as yourself. As a last resort turn Tailscale-only off. |
| 403 `login-not-allowed` | Your tailnet login is not in `ownerAccess.allowedLogins`. |
| 404 on `/api/owner/pair` | Owner access is off (`ownerAccess.enabled`). |
| 401 | The pairing code expired or was used, or the device was revoked: get a new code. |
| "busy" | Another client is attached; take over, or close it. |
| Build mismatch | See [Updates](#11-updates): publish the Linux leg, then **Update host**. |
| The host never updates | `journalctl --user -u maestro | grep -i update`. Confirm `hostUpdates.mode` is `when-idle` (`status`), that the feed has `v1-stable-linux.yml` with the same version as Windows, and that the AppImage folder is writable. A host that is always busy waits; use **Update host** on the mismatch screen, or restart the service when it is idle. |
| Maestro logs | VM: `~/.config/chorus/logs/`. Windows client: `%APPDATA%\chorus-client\logs\`. |
