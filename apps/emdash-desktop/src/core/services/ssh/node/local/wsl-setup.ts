import { execFile, spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { listWslDistros } from './wsl-distros';

/**
 * Setting a repository up inside a WSL2 distro with one action: make sure a distro exists and
 * has what a project needs, then copy the repository into it. Everything runs through
 * `wsl.exe` directly, before any Host connection, so a distro that was just installed, or one
 * whose workspace server has not started yet, is prepared before that server reads its
 * environment.
 */

export type WslRepositorySetup = {
  readonly distro: string;
  /** The copy's absolute path inside the distro. */
  readonly path: string;
  /** True when a copy from an earlier run was found and kept. */
  readonly reused: boolean;
  /** What was done on the way, and what is left for the user, one sentence each. */
  readonly notes: readonly string[];
};

export type WslSetupDeps = {
  env?: NodeJS.ProcessEnv;
  /** Runs a Windows program and returns its stdout; rejects on a non-zero exit. */
  run?: (file: string, args: readonly string[], input?: string) => Promise<string>;
  listDistros?: typeof listWslDistros;
  username?: string;
};

const DEFAULT_DISTRO = 'Ubuntu';

/** `C:\x\y` as the distro sees it; null for anything that is not on a drive. */
export function windowsPathInWsl(windowsPath: string): string | null {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!drive) return null;
  const rest = (drive[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${(drive[1] ?? '').toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** A folder name that is safe as one path segment in the distro. */
export function repositoryFolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'repository';
}

/** A Linux user name made from the Windows one: lower case, starting with a letter. */
export function linuxUserName(windowsName: string): string {
  const cleaned = windowsName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 30);
  return cleaned || 'dev';
}

/**
 * The script that prepares the distro and copies the repository. It runs in the distro as the
 * default user and prints `key=value` lines: `note=` for each thing it did or could not do,
 * `reused=1` when it kept an earlier copy, and `path=` last. Arguments: the repository as the
 * distro sees it on the Windows drive, the folder name, the remote URL, the git name and email.
 */
export const WSL_REPOSITORY_SETUP_SCRIPT = `set -eu
src="$1"; name="$2"; origin="$3"; gname="$4"; gemail="$5"
note() { printf 'note=%s\\n' "$1"; }
fail() { printf 'error=%s\\n' "$1"; exit 20; }

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n apt-get update -qq >/dev/null 2>&1 || true
    sudo -n apt-get install -y -qq git >/dev/null 2>&1 || true
  fi
fi
command -v git >/dev/null 2>&1 || fail 'git is not installed in the distro. Install it there (for example: sudo apt-get install git) and try again.'
if ! command -v tmux >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n apt-get install -y -qq tmux >/dev/null 2>&1 && note 'Installed tmux in the distro.' || true
fi

if [ -n "$gname" ] && [ -z "$(git config --global user.name 2>/dev/null || true)" ]; then
  git config --global user.name "$gname" && note 'Set the git name in the distro to the one you use on Windows.'
fi
if [ -n "$gemail" ] && [ -z "$(git config --global user.email 2>/dev/null || true)" ]; then
  git config --global user.email "$gemail" && note 'Set the git email in the distro to the one you use on Windows.'
fi
if [ -z "$(git config --global credential.helper 2>/dev/null || true)" ]; then
  for gcm in "/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe" "/mnt/c/Program Files (x86)/Git/mingw64/bin/git-credential-manager.exe"; do
    if [ -x "$gcm" ]; then
      git config --global credential.helper "$(printf '%s' "$gcm" | sed 's/[ ()]/\\\\&/g')"
      note 'git in the distro now signs in through Git Credential Manager on Windows, so HTTPS remotes use the logins you already have.'
      break
    fi
  done
fi
if [ -z "$(git config --global credential.helper 2>/dev/null || true)" ]; then
  case "$origin" in
    http*) note 'No git sign-in is set up in the distro: pushing to this remote will ask for credentials there.' ;;
  esac
fi
case "$origin" in
  git@*|ssh://*) [ -e "$HOME/.ssh" ] || note 'This remote uses SSH and the distro has no SSH key yet: add one before pushing or pulling.' ;;
esac

root="$HOME/emdash/repositories"
mkdir -p "$root"
target="$root/$name"
n=2
reused=0
while [ -e "$target" ]; do
  if [ -n "$origin" ] && [ -d "$target/.git" ] && [ "$(git -C "$target" config --get remote.origin.url 2>/dev/null || true)" = "$origin" ]; then
    reused=1
    break
  fi
  target="$root/$name-$n"
  n=$((n + 1))
done
if [ "$reused" = 1 ]; then
  printf 'reused=1\\n'
else
  # The Windows checkout belongs to another user as the distro sees it, which git refuses to
  # read unless told this one directory is fine.
  git -c "safe.directory=$src" -c "safe.directory=$src/.git" clone --quiet --no-hardlinks "$src" "$target" \\
    || fail 'The repository could not be copied into the distro.'
  if [ -n "$origin" ]; then
    git -C "$target" remote set-url origin "$origin"
  else
    git -C "$target" remote remove origin 2>/dev/null || true
    note 'The repository has no remote; the copy in the distro has none either.'
  fi
fi

if ! PATH="$HOME/.local/bin:$PATH" command -v claude >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1 && curl -fsSL https://claude.ai/install.sh 2>/dev/null | bash >/dev/null 2>&1; then
    note 'Installed Claude Code in the distro. Sign in once: open a terminal on this machine and run "claude".'
  else
    note 'Claude Code is not installed in the distro and could not be installed for you.'
  fi
elif [ ! -e "$HOME/.claude/.credentials.json" ] && [ -z "\${ANTHROPIC_API_KEY:-}" ]; then
  note 'Claude Code in the distro is not signed in yet: open a terminal on this machine and run "claude" once.'
fi
printf 'path=%s\\n' "$target"
`;

/** Reads the setup script's `key=value` output. */
export function parseSetupOutput(stdout: string): {
  path: string | null;
  reused: boolean;
  notes: string[];
  error: string | null;
} {
  const result = {
    path: null as string | null,
    reused: false,
    notes: [] as string[],
    error: null as string | null,
  };
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (key === 'note' && value) result.notes.push(value);
    else if (key === 'path' && value.startsWith('/')) result.path = value;
    else if (key === 'reused') result.reused = value === '1';
    else if (key === 'error' && value) result.error = value;
  }
  return result;
}

function wslExecutable(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  return root ? `${root}\\System32\\wsl.exe` : 'wsl.exe';
}

function defaultRun(file: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: 'pipe', windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else {
        // The script reports what went wrong on stdout; keep it for the caller to read.
        const error = new Error(stderr.replace(/\0/g, '').trim() || `exited with code ${code}`);
        (error as Error & { stdout?: string }).stdout = stdout;
        reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function gitOnWindows(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      resolve(error ? '' : String(stdout).trim())
    );
  });
}

/**
 * The distro to set a repository up in: the wanted one, else the first usable one, else a new
 * Ubuntu. A new distro gets a user named after the Windows user, who may use sudo without a
 * password, as the store version sets up interactively. Installing needs WSL itself to be
 * enabled already; when it is not, `wsl.exe` says so and that message is passed on.
 */
export async function ensureWslDistro(
  wanted: string | undefined,
  deps: WslSetupDeps = {}
): Promise<{ distro: string; installed: boolean }> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const list = deps.listDistros ?? listWslDistros;
  const distros = await list(env);
  if (wanted) {
    const found = distros.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new Error(`No WSL2 distro is called "${wanted}".`);
    return { distro: found.name, installed: false };
  }
  const [first] = distros;
  if (first) return { distro: first.name, installed: false };

  const wsl = wslExecutable(env);
  try {
    await run(wsl, ['--install', '-d', DEFAULT_DISTRO, '--no-launch']);
  } catch (error) {
    throw new Error(
      `Ubuntu could not be installed for WSL2: ${error instanceof Error ? error.message : String(error)}. Run "wsl --install" in a terminal once, restart if it asks, and try again.`
    );
  }
  const user = linuxUserName(deps.username ?? userInfo().username);
  const createUser =
    `id ${user} >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo ${user}; ` +
    `echo '${user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${user}; chmod 440 /etc/sudoers.d/${user}; ` +
    `printf '[user]\\ndefault=${user}\\n' > /etc/wsl.conf`;
  await run(wsl, ['-d', DEFAULT_DISTRO, '-u', 'root', '--exec', '/bin/sh', '-c', createUser]);
  // The default user takes effect when the distro next starts.
  await run(wsl, ['--terminate', DEFAULT_DISTRO]).catch(() => '');
  return { distro: DEFAULT_DISTRO, installed: true };
}

/**
 * Copies the repository at `windowsPath` into the distro and prepares the distro for it.
 * The copy holds what is committed: uncommitted changes stay in the Windows folder.
 */
export async function setUpRepositoryInWsl(
  /** `live`: the copy is about to be mirrored with the Windows folder, which the notes say. */
  input: { windowsPath: string; name: string; distro?: string; live?: boolean },
  deps: WslSetupDeps = {}
): Promise<WslRepositorySetup> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const source = windowsPathInWsl(input.windowsPath);
  if (!source) throw new Error('Only a repository on a Windows drive can be copied into WSL.');

  const { distro, installed } = await ensureWslDistro(input.distro, deps);
  const [origin, gitName, gitEmail] = await Promise.all([
    gitOnWindows(['remote', 'get-url', 'origin'], input.windowsPath),
    gitOnWindows(['config', '--global', 'user.name']),
    gitOnWindows(['config', '--global', 'user.email']),
  ]);

  let stdout: string;
  try {
    stdout = await run(
      wslExecutable(env),
      [
        '-d',
        distro,
        '--cd',
        '~',
        '--exec',
        '/bin/sh',
        '-s',
        '--',
        source,
        repositoryFolderName(input.name),
        origin,
        gitName,
        gitEmail,
      ],
      WSL_REPOSITORY_SETUP_SCRIPT
    );
  } catch (error) {
    const reported = parseSetupOutput((error as { stdout?: string }).stdout ?? '').error;
    throw new Error(reported ?? (error instanceof Error ? error.message : String(error)));
  }
  const parsed = parseSetupOutput(stdout);
  if (!parsed.path) throw new Error(parsed.error ?? 'The distro did not report where the copy is.');
  return {
    distro,
    path: parsed.path,
    reused: parsed.reused,
    notes: [
      ...(installed
        ? [
            `Installed Ubuntu for WSL2, with the user "${linuxUserName(deps.username ?? userInfo().username)}".`,
          ]
        : []),
      ...parsed.notes,
      ...(input.live
        ? [
            parsed.reused
              ? 'A copy of this repository was already in the distro. It is brought in line with the Windows folder; anything replaced there is kept in its .git/maestro-mirror/trash for a week.'
              : 'The Windows folder and its copy in the distro are kept the same from now on, both ways, uncommitted work included.',
            'Installed packages and build output are not mirrored: install dependencies in the distro once.',
          ]
        : parsed.reused
          ? ['A copy of this repository was already in the distro and was kept as it is.']
          : ['The copy holds what is committed. Uncommitted changes stay in the Windows folder.']),
    ],
  };
}
