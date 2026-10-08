import { randomInt, timingSafeEqual } from 'node:crypto';

// No 0/O, 1/I/L: the code is read off one screen and typed on another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60_000;
const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES_PER_WINDOW = 10;

export type PairingCode = {
  /** Display form, `ABCD-EFGH`. */
  code: string;
  expiresAt: number;
};

export type PairingAttempt = 'accepted' | 'invalid' | 'rate-limited';

/**
 * One-time codes that turn "I can read the host's screen" into a device credential. A single
 * code is live at a time and it is consumed on first use. Failures are counted for the whole
 * listener, not per address: behind a tunnel every caller arrives from loopback.
 */
export class PairingCodes {
  private active: { normalized: string; expiresAt: number } | undefined;
  private failures: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  issue(): PairingCode {
    let normalized = '';
    for (let index = 0; index < CODE_LENGTH; index += 1) {
      normalized += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    const expiresAt = this.now() + CODE_TTL_MS;
    this.active = { normalized, expiresAt };
    return { code: formatPairingCode(normalized), expiresAt };
  }

  /** The live code, for redisplay; undefined once used or expired. */
  current(): PairingCode | undefined {
    const active = this.liveCode();
    return active
      ? { code: formatPairingCode(active.normalized), expiresAt: active.expiresAt }
      : undefined;
  }

  cancel(): void {
    this.active = undefined;
  }

  redeem(presented: string): PairingAttempt {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES_PER_WINDOW) return 'rate-limited';

    const active = this.liveCode();
    const candidate = normalizePairingCode(presented);
    if (active && candidate.length === active.normalized.length) {
      const matches = timingSafeEqual(Buffer.from(candidate), Buffer.from(active.normalized));
      if (matches) {
        this.active = undefined;
        return 'accepted';
      }
    }
    this.failures.push(now);
    return 'invalid';
  }

  private liveCode(): { normalized: string; expiresAt: number } | undefined {
    if (this.active && this.active.expiresAt <= this.now()) this.active = undefined;
    return this.active;
  }
}

export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function formatPairingCode(normalized: string): string {
  const half = Math.ceil(normalized.length / 2);
  return `${normalized.slice(0, half)}-${normalized.slice(half)}`;
}
