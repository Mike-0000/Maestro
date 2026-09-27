/**
 * Root merge gate: runs format, lint, typecheck, and test in order via the
 * existing Nx-powered root scripts. Equivalent to running the four commands
 * by hand; stops at the first failure.
 */
import { spawnSync } from 'node:child_process';
import { deliveryBootstrapCommands } from '../../apps/emdash-desktop/src/core/features/local-updates/node/coordinator/build-validation.mjs';
import { pnpmCommand } from './pnpm-command.mjs';

// Compatibility with installed coordinators whose fixed `workspace-check` still invokes this
// script. The candidate supplies its own checks while the installed app retains control of
// validation, package creation, promotion, and the install worker.
const deliveryCommands = deliveryBootstrapCommands();
if (deliveryCommands) {
  for (const [name, command] of deliveryCommands) {
    console.log(`\ncheck: running Chorus delivery ${name}\n`);
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) {
      console.error(`\ncheck: Chorus delivery ${name} failed.`);
      process.exit(typeof result.status === 'number' ? result.status : 1);
    }
  }
  console.log('\ncheck: Chorus delivery native setup, static checks, and focused tests passed.');
  process.exit(0);
}

const steps = ['format', 'lint', 'typecheck', 'test'];

for (const step of steps) {
  console.log(`\ncheck: running pnpm run ${step}\n`);
  const pnpm = pnpmCommand(['run', step]);
  const result = spawnSync(pnpm.command, pnpm.args, { stdio: 'inherit', shell: pnpm.shell });
  if (result.status !== 0) {
    console.error(
      `\ncheck: failed at "pnpm run ${step}".` +
        '\nIf the failure looks environmental, run `pnpm run doctor` to rule out your setup.'
    );
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
}

console.log('\ncheck: format, lint, typecheck, and test all passed.');
