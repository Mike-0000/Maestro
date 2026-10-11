/**
 * Running an agent inside WSL2 from a Windows host. The agent process is started through
 * `wsl.exe` in the default distro; `wsl.exe` maps the Windows working directory to its
 * `/mnt/<drive>` path by itself. What has to be done here is everything else that crosses the
 * boundary: paths in arguments, the variables the agent needs (WSL forwards only those named in
 * `WSLENV`), and finding out whether a distro with the agent's CLI exists at all.
 *
 * Nothing here falls back silently inside WSL: when the probe fails, the caller launches the
 * agent natively, as if the setting were off.
 */

/** A distro that can run the agent. */
export type WslTarget = {
  /** The distro's name, as `$WSL_DISTRO_NAME` reports it. */
  readonly distro: string;
  /** The user's home inside the distro, a POSIX path. */
  readonly home: string;
  /** Where the agent CLI is inside the distro. */
  readonly cli: string;
};

/** A drive path (`C:\x\y`) or a WSL share (`\\wsl.localhost\distro\x`) as WSL sees it. */
export function toWslPath(windowsPath: string): string | null {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (drive) {
    const rest = (drive[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${(drive[1] ?? '').toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const share = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+((?:\\.*)?)$/i.exec(windowsPath);
  if (share) return (share[1] ?? '').replace(/\\/g, '/') || '/';
  return null;
}

/** The same home as a Windows path, for writing files into the distro. */
export function wslHomeShare(target: WslTarget, ...segments: string[]): string {
  const parts = [...target.home.split('/').filter(Boolean), ...segments];
  return `\\\\wsl.localhost\\${target.distro}\\${parts.join('\\')}`;
}

/** A Windows drive path, wherever it stands in a sentence. Stops at whitespace and quotes. */
const DRIVE_PATH_IN_TEXT = /\b[A-Za-z]:\\[^\s"<>|]+/g;

/**
 * An agent argument as the agent must see it inside WSL. A path argument (`C:\x`) and a path
 * after a flag (`--mcp-config=C:\x`) are translated. The initial prompt may name the file a long
 * prompt was written to; that path is translated where it stands, and nothing else in the
 * prompt is touched.
 */
export function toWslArg(arg: string): string {
  const direct = toWslPath(arg);
  if (direct !== null) return direct;
  const flag = /^(--?[A-Za-z][\w-]*=)(.+)$/.exec(arg);
  if (flag) {
    const value = toWslPath(flag[2] ?? '');
    if (value !== null) return `${flag[1]}${value}`;
  }
  if (!arg.includes('emdash-tui-prompt-')) return arg;
  return arg.replace(DRIVE_PATH_IN_TEXT, (found) =>
    found.includes('emdash-tui-prompt-') ? (toWslPath(found) ?? found) : found
  );
}

/**
 * Variables that describe the Windows side and mean nothing, or the wrong thing, inside WSL.
 * `HOME` in particular is the Windows profile on the host, and the distro has its own.
 */
const WINDOWS_ONLY = new Set(
  [
    'PATH',
    'PATHEXT',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'OS',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'PSMODULEPATH',
    'SHELL',
    'WSLENV',
  ].map((name) => name.toUpperCase())
);

/** Variables whose value is a path, which WSL translates when asked to (`/p`). */
const PATH_VALUED = new Set(['CLAUDE_CONFIG_DIR']);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The environment for `wsl.exe`: the same variables, plus a `WSLENV` that names the ones the
 * agent is to receive. Variables already named in the user's own `WSLENV` keep their flags.
 */
export function withWslEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const named = new Map<string, string>();
  for (const entry of (env.WSLENV ?? '').split(':')) {
    const name = entry.split('/')[0] ?? '';
    if (name) named.set(name.toUpperCase(), entry);
  }
  for (const name of Object.keys(env)) {
    if (!ENV_NAME.test(name) || WINDOWS_ONLY.has(name.toUpperCase())) continue;
    if (named.has(name.toUpperCase())) continue;
    named.set(name.toUpperCase(), PATH_VALUED.has(name.toUpperCase()) ? `${name}/p` : name);
  }
  return { ...env, WSLENV: [...named.values()].join(':') };
}

/** The line the probe runs in the distro's login shell: the CLI, then the distro, then home. */
export function wslProbeLine(cliName: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(cliName)) throw new Error(`Not a CLI name: ${cliName}`);
  return `command -v ${cliName} && printf '%s\\n%s\\n' "$WSL_DISTRO_NAME" "$HOME"`;
}

/** Reads the probe's output. Null when the CLI is missing or the answer is not usable. */
export function parseWslProbe(stdout: string): WslTarget | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;
  const [cli, distro, home] = lines.slice(-3);
  if (!cli || !distro || !home) return null;
  if (!cli.startsWith('/') || !home.startsWith('/')) return null;
  // Docker Desktop's own distros are not for running anything in.
  if (/^docker-desktop/i.test(distro)) return null;
  // A CLI under /mnt is the Windows install seen through the drive mount, not one in the distro.
  if (/^\/mnt\/[a-z]\//i.test(cli)) return null;
  if (!/^[\w.-]+$/.test(distro)) return null;
  return { cli, distro, home };
}
