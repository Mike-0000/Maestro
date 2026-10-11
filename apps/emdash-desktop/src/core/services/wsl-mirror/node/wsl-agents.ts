import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MIRROR_AGENT_SOURCE } from './mirror-agent-source';
import { createProcessAgent, createWorkerAgent } from './mirror-agents';
import type { MirrorAgents } from './mirror-session';

/**
 * Takes the Windows directories off the distro's PATH, which WSL appends to it. Left in, a
 * distro without git would find `git.exe` and run it against the Linux copy.
 */
const WSL_POSIX_PATH =
  'PATH=$(printf %s "$PATH" | tr ":" "\\n" | grep -v "^/mnt/[a-z]/" | paste -sd: -); export PATH';

/** `C:\x\y` under the default drive mount, for when the distro cannot be asked. */
function windowsPathInWsl(windowsPath: string): string | null {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!drive) return null;
  const rest = (drive[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${(drive[1] ?? '').toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** This app's own variables stay out of the distro; the rest is the user's session. */
function localShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/^(ELECTRON_|EMDASH_|VITE_)/iu.test(key)) continue;
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_ENV)$/iu.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * The two agents of a mirror between a Windows folder and a WSL2 distro: one on a thread of
 * this app, one inside the distro. The distro's agent is the same program, written into the
 * distro's home and run by the Node that the workspace server there ships with, so the distro
 * needs nothing installed for it.
 */

export type WslMirrorTarget = {
  readonly windowsPath: string;
  readonly distro: string;
  readonly linuxPath: string;
  readonly preserve: readonly string[];
};

function wslExecutable(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  return root ? `${root}\\System32\\wsl.exe` : 'wsl.exe';
}

const AGENT_NAME = `agent-${createHash('sha256').update(MIRROR_AGENT_SOURCE).digest('hex').slice(0, 16)}.cjs`;

/**
 * Writes the agent into the distro unless this version is already there, and prints the
 * Windows folder as the distro sees it. The program arrives on stdin; `$1` is the folder.
 */
const DEPLOY_SCRIPT = `set -eu
dir="$HOME/.emdash/mirror"
mkdir -p "$dir"
file="$dir/${AGENT_NAME}"
if [ -s "$file" ]; then cat > /dev/null; else cat > "$file.tmp" && mv "$file.tmp" "$file"; fi
find "$dir" -maxdepth 1 -name 'agent-*.cjs' ! -name '${AGENT_NAME}' -delete 2>/dev/null || true
wslpath -a -u "$1" 2>/dev/null || true
`;

/**
 * Starts the agent with the workspace server's Node, or the distro's own. Windows directories
 * are taken off PATH first, so `git` can only ever be the distro's git.
 */
const RUN_SCRIPT = `${WSL_POSIX_PATH}
node="$HOME/.emdash/workspace-server/current/node"
[ -x "$node" ] || node="$(command -v node || true)"
if [ -z "$node" ]; then
  echo "Node.js was not found in the distro. Connect the WSL machine once, so its workspace server is installed." >&2
  exit 127
fi
exec "$node" "$HOME/.emdash/mirror/${AGENT_NAME}"
`;

function runInDistro(
  env: NodeJS.ProcessEnv,
  distro: string,
  script: string,
  args: readonly string[],
  input: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      wslExecutable(env),
      ['-d', distro, '--cd', '~', '--exec', '/bin/sh', '-c', script, 'sh', ...args],
      { stdio: 'pipe', windowsHide: true, env: localShellEnvironment(env) }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(stderr.replace(/\0/g, '').trim() || `wsl.exe exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function createWslMirrorAgents(
  target: WslMirrorTarget,
  env: NodeJS.ProcessEnv = process.env
): Promise<MirrorAgents> {
  const fallback = windowsPathInWsl(target.windowsPath);
  if (!fallback) throw new Error('Only a folder on a Windows drive can be mirrored into WSL.');
  const printed = await runInDistro(
    env,
    target.distro,
    DEPLOY_SCRIPT,
    [target.windowsPath],
    MIRROR_AGENT_SOURCE
  );
  const seen = printed.trim().split(/\r?\n/).pop() ?? '';
  const peerRoot = seen.startsWith('/') ? seen.replace(/\/+$/, '') : fallback;

  const preserve = [...target.preserve];
  return {
    a: {
      agent: createWorkerAgent(MIRROR_AGENT_SOURCE),
      init: { root: target.windowsPath, preserve },
    },
    b: {
      agent: createProcessAgent(
        wslExecutable(env),
        ['-d', target.distro, '--cd', '~', '--exec', '/bin/sh', '-c', RUN_SCRIPT],
        { env: localShellEnvironment(env) }
      ),
      init: { root: target.linuxPath, peerRoot, preserve },
    },
  };
}
