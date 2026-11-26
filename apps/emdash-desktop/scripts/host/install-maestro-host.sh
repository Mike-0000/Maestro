#!/usr/bin/env bash
# Sets up and looks after a headless Maestro host on Linux (Ubuntu 22.04 or later, x64).
# See docs/chorus/remote-rig.md for the whole setup, including Tailscale and pairing.
#
#   install-maestro-host.sh install [--appimage <file>]   AppImage, wrapper and systemd user unit
#   install-maestro-host.sh configure [--manual-updates]  turn on remote and owner access (service stopped)
#   install-maestro-host.sh pairing-code                  issue a code for a client (service running)
#   install-maestro-host.sh status                        service, settings and listener at a glance
#   install-maestro-host.sh doctor                        check everything a headless host needs
#
# Without --appimage, `install` downloads the current Linux release from the update feed and checks
# it against the SHA-512 in the feed's manifest. Run it again to replace the AppImage by hand; the
# running host normally updates itself (hostUpdates.mode "when-idle").
#
# Environment: MAESTRO_FEED_URL (update feed), MAESTRO_USER_DATA (default ~/.config/chorus).
set -euo pipefail

feed="${MAESTRO_FEED_URL:-https://stmaestroupdd5313e.blob.core.windows.net/maestro}"
install_dir="$HOME/.local/share/maestro"
appimage="$install_dir/Maestro.AppImage"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
user_data="${MAESTRO_USER_DATA:-${XDG_CONFIG_HOME:-$HOME/.config}/chorus}"
settings="$user_data/remote-access.json"
token_file="$user_data/owner-setup.token"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  echo "install-maestro-host: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is missing ($2)"
}

service_active() {
  systemctl --user is-active --quiet maestro.service 2>/dev/null
}

download_appimage() {
  need curl "sudo apt install curl"
  need openssl "sudo apt install openssl"
  local manifest path expected tmp actual
  manifest="$(curl -fsSL "$feed/v1-stable-linux.yml")" ||
    die "no Linux release on $feed yet (publish one with maestro-linux-release.ts)"
  path="$(printf '%s\n' "$manifest" | sed -n 's/^path: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p')"
  expected="$(printf '%s\n' "$manifest" | sed -n 's/^sha512: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p')"
  [ -n "$path" ] && [ -n "$expected" ] || die "the feed's Linux manifest has no path or sha512"
  echo "Downloading $feed/$path"
  tmp="$(mktemp "$install_dir/.download.XXXXXX")"
  curl -fL --progress-bar -o "$tmp" "$feed/$path" || { rm -f "$tmp"; die "download failed"; }
  actual="$(openssl dgst -sha512 -binary "$tmp" | base64 -w0)"
  if [ "$actual" != "$expected" ]; then
    rm -f "$tmp"
    die "the download does not match the manifest's SHA-512"
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$appimage"
}

cmd_install() {
  local source=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --appimage) source="$2"; shift 2 ;;
      *) die "unknown argument $1" ;;
    esac
  done
  [ "$(uname -m)" = "x86_64" ] || die "the Linux release is x64 only"
  need systemctl "systemd is required"
  command -v Xvfb >/dev/null 2>&1 || die "Xvfb is missing (sudo apt install xvfb)"
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    die "libfuse2 is missing, AppImages need it (Ubuntu 24.04: sudo apt install libfuse2t64; 22.04: libfuse2)"
  fi
  if service_active; then
    die "maestro.service is running; stop it first: systemctl --user stop maestro"
  fi

  mkdir -p "$install_dir" "$unit_dir"
  if [ -n "$source" ]; then
    [ -f "$source" ] || die "$source does not exist"
    install -m 755 "$source" "$appimage"
  else
    download_appimage
  fi
  install -m 755 "$script_dir/maestro-host-run.sh" "$install_dir/maestro-host-run.sh"
  install -m 644 "$script_dir/maestro.service" "$unit_dir/maestro.service"
  systemctl --user daemon-reload
  echo "Installed $appimage"
  echo "Installed $unit_dir/maestro.service"
  if ! loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
    echo "Next: sudo loginctl enable-linger $USER   (keeps the service running while you are logged out)"
  fi
  echo "Then: $0 configure && systemctl --user enable --now maestro"
}

cmd_configure() {
  local mode="when-idle"
  while [ $# -gt 0 ]; do
    case "$1" in
      --manual-updates) mode="manual"; shift ;;
      *) die "unknown argument $1" ;;
    esac
  done
  need python3 "sudo apt install python3"
  # Maestro keeps these settings in memory and rewrites the file; edit it only while it is stopped.
  if service_active; then
    die "maestro.service is running; stop it first: systemctl --user stop maestro"
  fi
  mkdir -p "$user_data"
  python3 - "$settings" "$mode" <<'PY'
import json, os, shutil, sys, time, uuid

path, mode = sys.argv[1], sys.argv[2]
state = None
if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
    except ValueError:
        state = None
    if not isinstance(state, dict) or state.get("version") != 1:
        backup = f"{path}.{int(time.time())}.bak"
        shutil.copy2(path, backup)
        print(f"Unreadable settings kept as {backup}")
        state = None
if state is None:
    state = {
        "version": 1,
        "enabled": False,
        "port": 7462,
        "bindAddress": "127.0.0.1",
        "hostId": str(uuid.uuid4()),
        "devices": [],
    }
state["enabled"] = True
owner = state.get("ownerAccess") if isinstance(state.get("ownerAccess"), dict) else {}
owner["enabled"] = True
owner.setdefault("tailscaleOnly", True)
owner.setdefault("allowedLogins", [])
state["ownerAccess"] = owner
state["hostUpdates"] = {"mode": mode}
temporary = f"{path}.tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2)
os.chmod(temporary, 0o600)
os.replace(temporary, path)
print(f"Remote access on, port {state['port']} on {state['bindAddress']}")
print(f"Full-access clients on (Tailscale only: {owner['tailscaleOnly']})")
print(f"Host updates: {mode}")
PY
  echo "Settings: $settings"
  echo "Next: systemctl --user enable --now maestro"
}

cmd_pairing_code() {
  need curl "sudo apt install curl"
  [ -f "$token_file" ] ||
    die "$token_file does not exist yet: run '$0 configure', then start the service and wait a few seconds"
  local port
  port="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("port", 7462))' "$settings" 2>/dev/null || echo 7462)"
  # Direct loopback only: this endpoint refuses anything that came through a proxy or tunnel.
  curl -fsS -X POST \
    -H "Authorization: Bearer $(cat "$token_file")" \
    "http://127.0.0.1:$port/api/owner/pairing-code"
  echo
}

cmd_status() {
  systemctl --user --no-pager status maestro.service 2>/dev/null | head -n 5 || echo "maestro.service is not installed"
  if [ -f "$settings" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$settings" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
owner = state.get("ownerAccess", {})
print(f"remote access: {state.get('enabled')} on {state.get('bindAddress')}:{state.get('port')}")
print(f"owner access: {owner.get('enabled', False)}, Tailscale only: {owner.get('tailscaleOnly', True)}")
print(f"host updates: {state.get('hostUpdates', {}).get('mode', 'manual')}")
print(f"paired owners: {len(state.get('ownerDevices', []))}")
PY
  else
    echo "no settings yet ($settings)"
  fi
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve status 2>/dev/null || true
  fi
}

# Checks every prerequisite of an unattended host, the way the service sees them: agent CLIs are
# looked up through a login shell, as Maestro captures `$SHELL -ilc env` at start.
cmd_doctor() {
  local failures=0
  ok() { printf '  ok    %s\n' "$*"; }
  bad() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }
  warn() { printf '  warn  %s\n' "$*"; }
  login_shell="${SHELL:-/bin/bash}"
  in_login_shell() { "$login_shell" -ilc "$1" </dev/null 2>/dev/null; }

  echo "Machine"
  [ "$(uname -m)" = "x86_64" ] && ok "x64" || bad "not x64: the Linux release is x64 only"
  command -v Xvfb >/dev/null 2>&1 && ok "Xvfb" || bad "Xvfb missing: sudo apt install xvfb"
  ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' && ok "libfuse2" ||
    bad "libfuse2 missing: sudo apt install libfuse2t64 (22.04: libfuse2)"
  loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes' && ok "linger on" ||
    bad "linger off: sudo loginctl enable-linger $USER (otherwise the service stops at logout)"
  if [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then ok "swap on"; else
    warn "no swap: add a 4 GB swapfile on small VMs"; fi

  echo "Agent tools (through $login_shell as a login shell)"
  for tool in git claude; do
    if path="$(in_login_shell "command -v $tool")" && [ -n "$path" ]; then ok "$tool: $path"; else
      bad "$tool not found on the login shell's PATH"; fi
  done
  if in_login_shell 'command -v gh' >/dev/null; then ok "gh"; else warn "gh not found (only needed for GitHub work)"; fi
  if in_login_shell 'claude auth status' >/dev/null; then ok "claude is signed in"; else
    bad "claude is not signed in: run 'claude' over SSH and log in with your Claude account"; fi
  if in_login_shell 'printenv ANTHROPIC_API_KEY' >/dev/null; then
    warn "ANTHROPIC_API_KEY is set: agents bill the API instead of your Claude plan"; fi

  echo "Maestro"
  [ -x "$appimage" ] && ok "$appimage" || bad "no AppImage: $0 install"
  [ -f "$unit_dir/maestro.service" ] && ok "systemd unit" || bad "no systemd unit: $0 install"
  systemctl --user is-enabled --quiet maestro.service 2>/dev/null && ok "service enabled" ||
    bad "service not enabled: systemctl --user enable --now maestro"
  service_active && ok "service running" || bad "service not running: journalctl --user -u maestro -e"
  if [ -f "$settings" ] && python3 - "$settings" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
sys.exit(0 if state.get("enabled") and state.get("ownerAccess", {}).get("enabled") else 1)
PY
  then ok "remote and owner access on"; else bad "remote or owner access off: $0 configure (service stopped)"; fi

  echo "Network"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve status 2>/dev/null | grep -q '127.0.0.1:' && ok "tailscale serve forwards to Maestro" ||
      bad "tailscale serve is not set up: sudo tailscale serve --bg 7462"
  else
    bad "tailscale missing: curl -fsSL https://tailscale.com/install.sh | sh"
  fi
  if command -v curl >/dev/null 2>&1; then
    latest="$(curl -fsSL "$feed/v1-stable-linux.yml" 2>/dev/null | sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' || true)"
    [ -n "$latest" ] && ok "feed's Linux release: $latest" || bad "the feed has no Linux release yet"
  fi

  if [ "$failures" -eq 0 ]; then echo "All checks passed."; else echo "$failures check(s) failed."; exit 1; fi
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  configure) shift; cmd_configure "$@" ;;
  pairing-code) shift; cmd_pairing_code "$@" ;;
  status) shift; cmd_status "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
