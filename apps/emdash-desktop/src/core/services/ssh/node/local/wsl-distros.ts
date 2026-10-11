import { execFile } from 'node:child_process';

export type WslDistro = { readonly name: string; readonly isDefault: boolean };

/**
 * Reads `wsl.exe --list --verbose`, which prints UTF-16 with a header row and marks the default
 * distro with `*`. Only WSL2 distros that can run a Host are returned: Docker Desktop keeps
 * distros of its own that are not for running anything in.
 */
export function parseWslDistroList(output: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const raw of output.replace(/\0/g, '').split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const isDefault = line.startsWith('*');
    const columns = line.replace(/^\*\s*/, '').split(/\s+/);
    const version = columns.at(-1);
    // The name may contain spaces in principle; state and version are the last two columns.
    const name = columns.slice(0, -2).join(' ');
    if (!name || version !== '2') continue;
    if (/^docker-desktop/i.test(name)) continue;
    distros.push({ name, isDefault });
  }
  // The default first: it is the one the user most likely means.
  return distros.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** The WSL2 distros on this computer that can be a Host; empty when WSL is not installed. */
export function listWslDistros(env: NodeJS.ProcessEnv = process.env): Promise<WslDistro[]> {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  const executable = root ? `${root}\\System32\\wsl.exe` : 'wsl.exe';
  return new Promise((resolve) => {
    execFile(
      executable,
      ['--list', '--verbose'],
      { encoding: 'utf16le', timeout: 15_000, windowsHide: true },
      (error, stdout) => resolve(error ? [] : parseWslDistroList(String(stdout)))
    );
  });
}
