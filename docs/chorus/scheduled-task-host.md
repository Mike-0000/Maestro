# Runbook: a headless VM that runs Maestro scheduled tasks

Step-by-step instructions, written for an agent (or a person) setting up a small Linux VM whose only
job is to run Maestro automations (scheduled tasks): one Claude agent at a time, with subagents,
on a weekly or daily timer, using the developer's included Claude usage. The developer controls it
from their Windows PC in client mode.

This is a narrow case of [remote-rig.md](remote-rig.md), which has the full reference (security,
updates, troubleshooting). Sizing and prices: [vm-sizing.md](vm-sizing.md).

## How it works

- The VM runs the Maestro Linux AppImage under `Xvfb`, as a systemd user service with lingering on,
  so it runs at boot with nobody logged in.
- The automations scheduler starts with Maestro's main process (`services:automations-init` in
  `src/main/bootstrap/boot/phases/services.ts`). Schedules fire with no window and no client
  attached; the developer's PC can be off.
- The developer edits automations from Windows: `Maestro.exe --maestro-client` connects to the VM
  over Tailscale, and the Automations screen there reads and writes the VM's automations (the
  `automations` domain is forwarded in `src/core/manifests/shared/client-mode-routing.ts`).
- **Close when done** makes a run unattended: the agent auto-approves its tool calls (it would
  otherwise stall on the first permission prompt with nobody watching) and is closed when it
  settles, or at the timeout (4 hours by default). Always turn it on for headless schedules.
- The host updates itself when idle (`hostUpdates.mode: "when-idle"`), from the same feed as the
  Windows app, so client and host stay on the same build.

## Who does what

Most steps need only an SSH session. These need the developer, because they sign in with their own
accounts in a browser; ask for them through the conductor (`ask_developer`) and continue with the
rest meanwhile:

| Step | Why the developer |
|---|---|
| Creating the VM, unless `az` is already signed in on this machine | Azure subscription |
| `sudo tailscale up` | opens a Tailscale login URL |
| `claude` login on the VM | the Claude account whose plan pays for the runs |
| `gh auth login`, if tasks use GitHub | GitHub account |
| Entering the pairing code in the Windows client | GUI on the PC (or a Codex agent with computer use) |

## 0. Before you start

The feed must carry a Linux release with the same version as Windows. Check:

```bash
curl -fsSL https://stmaestroupdd5313e.blob.core.windows.net/maestro/v1-stable-linux.yml | head -3
```

A 404 means no Linux release has been published yet: run `/push` on the developer's Windows machine
(it publishes the Linux leg after Windows, and needs Docker Desktop running), or
`push.mjs --linux-only` to add Linux to the last release.

## 1. Create the VM

Recommended: `Standard_B2as_v2` (2 vCPU, 8 GB), Ubuntu 24.04 LTS x64, 64 GB Standard SSD, no public
IP. x64 is required; ARM sizes cannot run the AppImage.

```bash
az group create -n rg-maestro-host -l <region>
az vm create -g rg-maestro-host -n maestro-host \
  --image Ubuntu2404 --size Standard_B2as_v2 \
  --os-disk-size-gb 64 --storage-sku StandardSSD_LRS \
  --admin-username maestro --generate-ssh-keys --public-ip-address ""
```

Without a public IP, run the first commands (through installing Tailscale) with
`az vm run-command invoke -g rg-maestro-host -n maestro-host --command-id RunShellScript --scripts "..."`
or the Azure Serial Console, then use SSH over Tailscale (`tailscale up --ssh` enables Tailscale SSH).
Alternatively, give it a public IP for setup, restrict port 22 to your address, and remove the IP
once Tailscale works.

## 2. System packages, swap and Tailscale

As the admin user:

```bash
sudo apt update
sudo apt install -y git curl openssl python3 xvfb libfuse2t64 build-essential
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh          # the developer opens the printed URL to sign in
sudo loginctl enable-linger "$USER"
```

## 3. Agent tools

Install Claude Code with its native installer (it lands in `~/.local/bin`, which Maestro puts on
PATH), plus Node if tasks need it:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude          # the developer completes the login with their Claude account, then /exit
claude auth status
```

- Do **not** set `ANTHROPIC_API_KEY`: with it, runs bill the API instead of the Claude plan.
- Maestro starts agents with the environment of `$SHELL -ilc env`, so anything a task needs on PATH
  must be set up in the login shell's profile (`~/.profile` or `~/.bashrc`), not in an SSH-only
  session.
- Add `gh` (`sudo apt install gh`, then `gh auth login`) only if tasks use GitHub.

## 4. Install and start Maestro

Copy `apps/emdash-desktop/scripts/host/` from the repository to the VM (`scp -r`, or clone the repo),
then:

```bash
cd ~/maestro-host && chmod +x *.sh
./install-maestro-host.sh install       # downloads and verifies the Linux AppImage from the feed
./install-maestro-host.sh configure     # remote access, owner access (Tailscale only), when-idle updates
systemctl --user enable --now maestro
sudo tailscale serve --bg 7462          # HTTPS on https://<vm>.<tailnet>.ts.net -> 127.0.0.1:7462
./install-maestro-host.sh doctor        # must end with "All checks passed."
```

Never enable Tailscale Funnel; it would publish the host on the internet.

## 5. Pair the Windows client

On the VM: `./install-maestro-host.sh pairing-code` prints a single-use code that expires in a few
minutes. On the PC (signed in to the same tailnet as a user, not a tagged device):

```powershell
& "$env:LOCALAPPDATA\Programs\Maestro\Maestro.exe" --maestro-client
```

Enter `https://<vm>.<tailnet>.ts.net` and the code, then use **Create a shortcut** in the connection
menu (the host name in the title bar) for a "Maestro Client" shortcut.

## 6. Create the scheduled task

In the client:

1. Add a project on the VM (browse to or clone into a folder under `/home/<user>/`). A research
   task can use an empty git repository as its workspace.
2. **Automations → New**: project, schedule, prompt, agent **Claude**, model, and **Effort**
   (`high`, `xhigh` or `max` for long research runs).
3. Turn on **Close when done**, and set its timeout longer than the longest expected run.
4. Start a run by hand once and watch it finish: the run history should show
   `Finished and closed`.

Only two close-when-done runs execute at once (`DEFAULT_MAX_CONCURRENT_CLOSE_RUNS`), in a pool
separate from other automations, so on a small VM keep schedules from overlapping.

## 7. Verify unattended operation

- Close the client and keep the PC off over the next scheduled time; afterwards, reconnect and
  check the run history.
- `sudo reboot` the VM, then `./install-maestro-host.sh doctor` once it is back: the service must
  come up by itself (linger on, service enabled).
- Logs: `journalctl --user -u maestro -e`, and Maestro's own logs in `~/.config/chorus/logs/`.

## Troubleshooting

| Symptom | Check |
|---|---|
| A run never starts | The service is running (`doctor`); the automation is enabled; the VM's clock and time zone (`timedatectl`). |
| A run starts but the agent sits idle | `claude auth status` in a login shell; the agent was signed out or its token expired. Log in again over SSH. |
| A run hangs until the timeout | Close when done was off, so the agent waited on a permission prompt. Turn it on. |
| `claude` works over SSH but not in runs | It is on PATH only in the SSH session. Put the PATH change in the login shell's profile; `doctor` checks it the way Maestro does. |
| The client shows a build mismatch | The Linux leg of the latest release is missing. Publish it (`push.mjs --linux-only`), then **Update host**. |
| The VM runs out of memory | Add or enlarge swap, or move to an 8 GB size if on 4 GB; `free -h`. |

Everything else: [remote-rig.md, Troubleshooting](remote-rig.md#13-troubleshooting).
