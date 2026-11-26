#!/usr/bin/env bash
# Builds the x64 Linux AppImage of one Maestro release for the update feed.
#
# Runs on x64 Linux: inside the Docker container maestro-linux-release.ts starts on Windows (the
# default), in a WSL distro (`--builder wsl`), or on the Linux host itself. It clones the given
# commit out of a source checkout into a work folder that keeps node_modules and download caches
# between runs, builds it the way /push builds Windows, and packages it with the version string
# the Windows release already has. Nothing is signed or uploaded here: publish the output folder
# from the Windows machine that holds the signing key.
#
#   build-linux-release.sh --source <repo> --commit <sha> --version <x.y.z-maestro.stamp> --out <dir>
#                          [--work <dir>]
#   build-linux-release.sh --check
#
# Environment: MAESTRO_NOTES (release notes), MAIN_VITE_REMOTE_LOGS_URL / _KEY (optional).
#
# The AppImage needs at least the glibc of the machine that built it (node-pty and better-sqlite3
# are compiled here). The Docker image is Debian 12 (glibc 2.36); a newer WSL distro produces an
# AppImage that may not start on an older host.
set -euo pipefail

source_repo=""
commit=""
version=""
out=""
work="${HOME}/.cache/maestro-linux-release"
check=0

die() {
  echo "build-linux-release: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source) source_repo="$2"; shift 2 ;;
    --commit) commit="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --work) work="$2"; shift 2 ;;
    --check) check=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done

missing=()
for tool in git node npm make g++ python3; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
arch="$(uname -m)"

if [ "$check" -eq 1 ]; then
  echo "arch: $arch"
  echo "glibc: $(ldd --version 2>/dev/null | head -n 1)"
  echo "node version: $(node --version 2>/dev/null || echo none)"
  for tool in git node npm pnpm make g++ python3; do
    printf '%s: %s\n' "$tool" "$(command -v "$tool" || echo missing)"
  done
  [ "${#missing[@]}" -eq 0 ] || die "missing: ${missing[*]} (Debian/Ubuntu: build-essential python3 git, and Node 24)"
  [ "$arch" = "x86_64" ] || die "x86_64 is required"
  echo "ok"
  exit 0
fi

[ -n "$source_repo" ] && [ -n "$commit" ] && [ -n "$version" ] && [ -n "$out" ] ||
  die "usage: --source <repo> --commit <sha> --version <version> --out <dir> [--work <dir>]"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "--commit must be a full commit id"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-maestro\.[0-9]{12}$ ]] || die "--version must be a Maestro release version"
[ "$arch" = "x86_64" ] || die "x86_64 is required"
[ "${#missing[@]}" -eq 0 ] || die "missing: ${missing[*]} (Debian/Ubuntu: build-essential python3 git, and Node 24)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die "Node 24 or later is required (found $(node --version))"

mkdir -p "$work" "$out"
repo="$work/repo"
export CI=true
export NX_DAEMON=false
export npm_config_store_dir="$work/pnpm-store"
export electron_config_cache="$work/cache/electron"
export ELECTRON_BUILDER_CACHE="$work/cache/electron-builder"
export PATH="$work/tools/bin:$PATH"

echo "==> Checking out $commit"
# The source checkout belongs to another user (a Windows drive, a read-only mount).
git_src() { git -c safe.directory='*' "$@"; }
if [ ! -d "$repo/.git" ]; then
  git_src clone --no-checkout "$source_repo" "$repo"
fi
git_src -C "$repo" fetch --no-tags --force "$source_repo" '+refs/heads/*:refs/remotes/source/*'
git -C "$repo" cat-file -e "${commit}^{commit}" || die "$commit is not on any branch of $source_repo"
git -C "$repo" -c advice.detachedHead=false checkout --detach --force "$commit"
# Keeps ignored files (node_modules, caches); drops anything else an earlier build left.
git -C "$repo" clean -fdq
rm -rf "$repo/apps/emdash-desktop/out"

cd "$repo"
pnpm_version="$(node -p 'require("./package.json").packageManager.split("@")[1].split("+")[0]')"
# Always its own pnpm: in WSL, `pnpm` on PATH can be the Windows one.
if [ "$("$work/tools/bin/pnpm" --version 2>/dev/null || true)" != "$pnpm_version" ]; then
  echo "==> Installing pnpm $pnpm_version into $work/tools"
  npm install --global --prefix "$work/tools" "pnpm@$pnpm_version" >/dev/null
fi

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Building workspace packages"
pnpm exec nx run-many -t build --all --exclude=@emdash/emdash-desktop

cd apps/emdash-desktop
echo "==> Building the app bundles"
pnpm exec electron-vite build
pnpm run build:remote-web

echo "==> Packaging the AppImage"
build_dir="$work/builds/$version"
rm -rf "$build_dir"
# electron-builder collects node_modules by the package manager it detects from this variable.
export npm_config_user_agent="pnpm/$(pnpm --version) npm/? node/$(node --version) linux x64"
node --experimental-strip-types scripts/release/build-maestro-update.ts \
  --platform linux \
  --version "$version" \
  --commit "$commit" \
  --skip-workspace-build \
  --output "$build_dir" \
  "--notes=${MAESTRO_NOTES:-Built from commit ${commit:0:12}.}"

echo "==> Copying the release to $out"
shopt -s nullglob
files=("$build_dir"/*-linux.yml "$build_dir"/*.AppImage "$build_dir"/*.AppImage.blockmap)
[ "${#files[@]}" -ge 2 ] || die "the build produced no AppImage and manifest in $build_dir"
cp -f "${files[@]}" "$out/"
ls -l "$out"
echo "done: $version"
