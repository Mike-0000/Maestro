import { describe, expect, it } from 'vitest';
import type { BuildIdentity } from '../api/build-identity';
import {
  attemptLabel,
  blockedCopy,
  formatLatency,
  headlessPairingCommand,
  hostAddressLabel,
  hostLabel,
  linkStateLabel,
  linkTone,
  olderSide,
  pairErrorHint,
  validatePairFields,
} from './client-session-format';
import { clientStatus } from './fake-client-session';

const build = (version: string, commit: string | null = null): BuildIdentity => ({
  version,
  commit,
  dev: false,
});

describe('host labels', () => {
  it('names the host, falling back to its address', () => {
    expect(hostLabel(clientStatus().host)).toBe('rig-vm');
    expect(hostLabel({ url: 'https://rig.tailnet.ts.net/', id: 'h', name: ' ' })).toBe(
      'rig.tailnet.ts.net'
    );
    expect(hostLabel(null)).toBe('the host');
  });

  it('shows an address without scheme or trailing slash', () => {
    expect(hostAddressLabel('https://rig.tailnet.ts.net/')).toBe('rig.tailnet.ts.net');
    expect(hostAddressLabel('http://127.0.0.1:7462')).toBe('127.0.0.1:7462');
    expect(hostAddressLabel('rig.tailnet.ts.net')).toBe('rig.tailnet.ts.net');
  });
});

describe('latency and link tone', () => {
  it('formats the round trip', () => {
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(0.4)).toBe('<1 ms');
    expect(formatLatency(23.6)).toBe('24 ms');
    expect(formatLatency(1240)).toBe('1.2 s');
    expect(formatLatency(Number.NaN)).toBeNull();
  });

  it('marks a slow, working or refused link', () => {
    expect(linkTone(clientStatus({ latencyMs: 24 }))).toBe('steady');
    expect(linkTone(clientStatus({ latencyMs: 300 }))).toBe('slow');
    expect(linkTone(clientStatus({ latencyMs: null }))).toBe('steady');
    expect(linkTone(clientStatus({ phase: 'reconnecting' }))).toBe('working');
    expect(linkTone(clientStatus({ phase: 'blocked' }))).toBe('down');
  });

  it('says the state in words', () => {
    expect(linkStateLabel(clientStatus())).toBe('Connected, 24 ms');
    expect(linkStateLabel(clientStatus({ latencyMs: null }))).toBe('Connected');
    expect(linkStateLabel(clientStatus({ phase: 'reconnecting' }))).toBe('Reconnecting');
  });
});

describe('pairing form', () => {
  const fields = { url: 'rig', code: 'ABCD', cfAccessClientId: '', cfAccessClientSecret: '' };

  it('asks for what is missing', () => {
    expect(validatePairFields({ ...fields, url: ' ' })).toBe(
      'Enter the address of the Maestro host.'
    );
    expect(validatePairFields({ ...fields, code: '' })).toBe(
      'Enter the pairing code shown by the host.'
    );
    expect(validatePairFields(fields)).toBeNull();
  });

  it('wants both Cloudflare Access values or neither', () => {
    expect(validatePairFields({ ...fields, cfAccessClientId: 'id.access' })).toMatch(/secret/u);
    expect(validatePairFields({ ...fields, cfAccessClientSecret: 's' })).toMatch(/client ID/u);
    expect(
      validatePairFields({ ...fields, cfAccessClientId: 'id.access', cfAccessClientSecret: 's' })
    ).toBeNull();
  });

  it('gives a next step for every failure it can explain', () => {
    for (const type of ['invalid', 'unreachable', 'rejected', 'unsupported'] as const) {
      expect(pairErrorHint(type)).toBeTruthy();
    }
    expect(pairErrorHint('failed')).toBeNull();
  });
});

describe('olderSide', () => {
  it('finds the side that is behind by version number', () => {
    expect(olderSide(build('1.4.2'), build('1.4.3'))).toBe('client');
    expect(olderSide(build('1.10.0'), build('1.9.9'))).toBe('host');
    expect(olderSide(build('2.0'), build('2.0.1'))).toBe('client');
    expect(olderSide(build('v1.4.2-beta.1'), build('1.4.3'))).toBe('client');
  });

  it('does not guess when the versions cannot tell', () => {
    expect(olderSide(build('1.4.2', 'aaaaaaa'), build('1.4.2', 'bbbbbbb'))).toBeNull();
    expect(olderSide(build('dev'), build('1.4.2'))).toBeNull();
    expect(olderSide(undefined, build('1.4.2'))).toBeNull();
  });
});

describe('blockedCopy', () => {
  const blocked = (reason: NonNullable<ReturnType<typeof clientStatus>['blocked']>['reason']) =>
    clientStatus({ phase: 'blocked', blocked: { reason } });

  it('names the host and says what to do for every reason', () => {
    for (const reason of [
      'build-mismatch',
      'revoked',
      'owner-disabled',
      'busy',
      'superseded',
      'tailscale-required',
    ] as const) {
      const copy = blockedCopy(blocked(reason));
      expect(copy.title, reason).toContain('rig-vm');
      expect(copy.description.length, reason).toBeGreaterThan(40);
    }
  });

  it('names the other client when the host reports it', () => {
    const status = clientStatus({
      phase: 'blocked',
      blocked: { reason: 'busy', busyClientName: 'Laptop' },
    });
    expect(blockedCopy(status).description).toContain('Laptop is connected.');
    expect(blockedCopy(blocked('busy')).description).toContain('Another Maestro client');
  });

  it('still has words when the host gave no reason', () => {
    expect(blockedCopy(clientStatus({ phase: 'blocked' })).title).toBe('Not connected to rig-vm');
  });
});

describe('small labels', () => {
  it('counts attempts only once there has been a retry', () => {
    expect(attemptLabel(0)).toBeNull();
    expect(attemptLabel(3)).toBe('Attempt 3');
  });

  it('builds the headless pairing command for the listener port', () => {
    expect(headlessPairingCommand()).toContain('http://127.0.0.1:7462/api/owner/pairing-code');
    expect(headlessPairingCommand(8000)).toContain(':8000/api/owner/pairing-code');
    expect(headlessPairingCommand()).toContain('owner-setup.token');
  });
});
