/** Length of a pairing code without its separator. */
export const PAIRING_CODE_LENGTH = 8;
const GROUP_LENGTH = 4;

/**
 * Reduces whatever was typed or pasted (`abcd-efgh`, `ABCD EFGH`) to the bare uppercase code,
 * capped at the code length.
 */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, PAIRING_CODE_LENGTH);
}

/** Display form of a (possibly partial) code: `ABCD-EFGH`. */
export function formatPairingCode(input: string): string {
  const code = normalizePairingCode(input);
  if (code.length <= GROUP_LENGTH) return code;
  return `${code.slice(0, GROUP_LENGTH)}-${code.slice(GROUP_LENGTH)}`;
}

export function isCompletePairingCode(input: string): boolean {
  return normalizePairingCode(input).length === PAIRING_CODE_LENGTH;
}
