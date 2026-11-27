import {
  CLIENT_MODE_SWITCH,
  isValidClientProfile,
} from '@core/primitives/client-mode/api/client-profile';

// Read by `src/entry/main.ts` before any bootstrap module loads, so it must stay free of
// Electron and of anything with side effects: plain string parsing only.

/**
 * Development alternative to the switch (ignored when packaged): `1` or `true` for the default
 * profile, or a name.
 */
export const CLIENT_MODE_ENV = 'MAESTRO_CLIENT';

export type LaunchMode = { mode: 'local' } | { mode: 'client'; profile: string | null };

const TRUE_VALUES = new Set(['1', 'true']);
const FALSE_VALUES = new Set(['', '0', 'false']);

/** Where the process runs; Electron-free, so the caller passes `app.isPackaged`. */
export type LaunchModeOptions = { isPackaged: boolean };

/**
 * How this process was asked to run. Without the client switch (or, in development, the
 * variable) it is always `local`, the app as it has always started. `--maestro-client[=<profile>]`
 * works in every build and wins over the variable. `MAESTRO_CLIENT` is a development convenience
 * only: a packaged build ignores it, so a stray environment variable can never turn the
 * installed app into a client. A profile that is not a valid slug falls back to the default
 * client profile.
 */
export function resolveLaunchMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: LaunchModeOptions
): LaunchMode {
  for (const arg of argv) {
    if (arg === CLIENT_MODE_SWITCH) return { mode: 'client', profile: null };
    if (arg.startsWith(`${CLIENT_MODE_SWITCH}=`)) {
      return { mode: 'client', profile: profileOrNull(arg.slice(CLIENT_MODE_SWITCH.length + 1)) };
    }
  }
  if (options.isPackaged) return { mode: 'local' };
  const raw = env[CLIENT_MODE_ENV]?.trim().toLowerCase();
  if (raw === undefined || FALSE_VALUES.has(raw)) return { mode: 'local' };
  if (TRUE_VALUES.has(raw)) return { mode: 'client', profile: null };
  return { mode: 'client', profile: profileOrNull(raw) };
}

function profileOrNull(value: string): string | null {
  const profile = value.trim().toLowerCase();
  return isValidClientProfile(profile) ? profile : null;
}
