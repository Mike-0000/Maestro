/**
 * Resolves how to run a nested pnpm command from a script that pnpm itself launched.
 *
 * Re-invoking the running pnpm entry (`npm_execpath`) through the current Node avoids a Windows
 * shell lookup. That lookup can pick up a global `pnpm.cmd` shim which launches the quoted `node`
 * from node_modules/.bin, where cmd.exe expands %~dp0 incorrectly and the nested command fails with
 * "The system cannot find the path specified".
 */
export function pnpmCommand(args, env = process.env) {
  const script = env.npm_execpath;
  if (script && /\.[cm]?js$/.test(script)) {
    return { command: process.execPath, args: [script, ...args], shell: false };
  }
  return { command: 'pnpm', args, shell: process.platform === 'win32' };
}
