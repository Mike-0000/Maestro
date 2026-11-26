#!/usr/bin/env bash
# Runs the Maestro AppImage headless on a Linux host, for the systemd user unit maestro.service.
#
# Starts a private Xvfb display, runs Maestro on it, and forwards SIGTERM to Maestro so a
# `systemctl --user stop` quits it cleanly before the display goes away. It exits with Maestro's
# status; systemd (`Restart=always`) starts it again, including after Maestro quits to install an
# update (MAESTRO_HOST_SERVICE=1 tells the updater to leave that restart to systemd).
#
# Environment (all optional):
#   MAESTRO_APPIMAGE        the AppImage (default ~/.local/share/maestro/Maestro.AppImage)
#   MAESTRO_PASSWORD_STORE  Chromium's --password-store (default basic; see docs/chorus/remote-rig.md)
#   MAESTRO_XVFB_SCREEN     virtual screen size (default 1920x1080x24)
#   MAESTRO_EXTRA_ARGS      more arguments for Maestro, split on spaces
set -u

appimage="${MAESTRO_APPIMAGE:-$HOME/.local/share/maestro/Maestro.AppImage}"
password_store="${MAESTRO_PASSWORD_STORE:-basic}"
screen="${MAESTRO_XVFB_SCREEN:-1920x1080x24}"

if [ ! -x "$appimage" ]; then
  echo "maestro-host: $appimage is missing or not executable" >&2
  exit 1
fi
if ! command -v Xvfb >/dev/null 2>&1; then
  echo "maestro-host: Xvfb is not installed (sudo apt install xvfb)" >&2
  exit 1
fi

# Xvfb picks a free display number and writes it to fd 3.
display_file="$(mktemp)"
Xvfb -displayfd 3 -screen 0 "$screen" -nolisten tcp -noreset 3>"$display_file" &
xvfb_pid=$!
for _ in $(seq 1 100); do
  [ -s "$display_file" ] && break
  kill -0 "$xvfb_pid" 2>/dev/null || break
  sleep 0.1
done
display="$(tr -d '[:space:]' <"$display_file")"
rm -f "$display_file"
if [ -z "$display" ]; then
  echo "maestro-host: Xvfb did not start" >&2
  kill "$xvfb_pid" 2>/dev/null
  exit 1
fi
export DISPLAY=":$display"
export MAESTRO_HOST_SERVICE=1

# shellcheck disable=SC2086 # MAESTRO_EXTRA_ARGS is a space-separated list on purpose.
"$appimage" --password-store="$password_store" ${MAESTRO_EXTRA_ARGS:-} &
app_pid=$!
trap 'kill -TERM "$app_pid" 2>/dev/null' TERM INT

status=0
# `wait` returns early when a trapped signal arrives; keep waiting until Maestro has exited.
while kill -0 "$app_pid" 2>/dev/null; do
  wait "$app_pid"
  status=$?
done

kill -TERM "$xvfb_pid" 2>/dev/null
wait "$xvfb_pid" 2>/dev/null
exit "$status"
