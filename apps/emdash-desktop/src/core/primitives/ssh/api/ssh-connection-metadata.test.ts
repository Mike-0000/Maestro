import { describe, expect, it } from 'vitest';
import { sshConfigFromRow, sshConnectionMetadata } from './ssh-connection-metadata';

// Migration tests for the versioned SSH connection metadata chain, per the
// versioned-schema conventions: every stored shape must upgrade to the latest
// version without data loss.
describe('sshConnectionMetadata versioned schema', () => {
  it('parses an unversioned v0 object and upgrades it to the latest version', () => {
    const result = sshConnectionMetadata.safeParse({
      sshConfigAlias: 'my-host',
      forwardAgent: true,
      proxyJump: 'jump-host',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.sshConfigAlias).toBe('my-host');
    expect(result.data.forwardAgent).toBe(true);
    expect(result.data.proxyJump).toBe('jump-host');
    // v4's field defaults to unset (treated as false by readers).
    expect(result.data.syncLocalSettings).toBeUndefined();
    expect(result.data.version).toBe(sshConnectionMetadata.currentVersion);
  });

  it('upgrades v3 data to the latest version preserving dependency selections', () => {
    const result = sshConnectionMetadata.safeParse({
      version: '3',
      sshConfigAlias: 'my-host',
      dependencySelections: {
        claude: { kind: 'pinned', realpath: '/usr/local/bin/claude' },
        codex: null,
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.version).toBe('7');
    expect(result.data.dependencySelections).toEqual({
      claude: { kind: 'pinned', realpath: '/usr/local/bin/claude' },
      codex: null,
    });
    expect(result.data.syncLocalSettings).toBeUndefined();
  });

  it('upgrades v4 machines to the latest version as SSH machines', () => {
    const result = sshConnectionMetadata.safeParse({
      version: '4',
      sshConfigAlias: 'my-host',
      syncLocalSettings: true,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({
      version: '7',
      sshConfigAlias: 'my-host',
      syncLocalSettings: true,
    });
    expect(result.data.transport).toBeUndefined();
  });

  it('upgrades a v5 local machine to v6 unchanged apart from the version', () => {
    const result = sshConnectionMetadata.safeParse({
      version: '5',
      transport: 'local',
      syncLocalSettings: true,
    });
    expect(result).toEqual({
      status: 'ok',
      data: { version: '7', transport: 'local', syncLocalSettings: true },
    });
  });

  it('round-trips a local machine through serialize/parseJson', () => {
    const value = sshConnectionMetadata.schema.parse({ version: '7', transport: 'local' });
    const roundTripped = sshConnectionMetadata.parseJson(sshConnectionMetadata.serialize(value));
    expect(roundTripped).toEqual({ version: '7', transport: 'local' });
  });

  it('round-trips a Maestro host through serialize/parseJson', () => {
    const value = sshConnectionMetadata.schema.parse({
      version: '7',
      transport: 'maestro',
      maestro: {
        url: 'https://my-pc.tailnet.ts.net',
        hostId: 'host-1',
        cfAccessClientId: 'client.access',
      },
    });
    const roundTripped = sshConnectionMetadata.parseJson(sshConnectionMetadata.serialize(value));
    expect(roundTripped).toEqual(value);
  });

  it('carries the Maestro endpoint into the machine config, never a secret', () => {
    const config = sshConfigFromRow({
      id: 'maestro-1',
      name: 'Studio',
      host: 'my-pc.tailnet.ts.net',
      port: 443,
      username: '',
      authType: 'agent',
      privateKeyPath: null,
      useAgent: 0,
      metadata: {
        version: '7',
        transport: 'maestro',
        maestro: { url: 'https://my-pc.tailnet.ts.net', hostId: 'host-1' },
      },
    });
    expect(config.transport).toBe('maestro');
    expect(config.maestro).toEqual({ url: 'https://my-pc.tailnet.ts.net', hostId: 'host-1' });
  });

  it('reports a version written by a newer app instead of guessing', () => {
    expect(sshConnectionMetadata.safeParse({ version: '8', transport: 'maestro' })).toMatchObject({
      status: 'future-version',
      version: '8',
    });
  });

  it('round-trips an object with syncLocalSettings through serialize/parseJson', () => {
    const value = sshConnectionMetadata.schema.parse({
      version: '7',
      sshConfigAlias: 'my-host',
      syncLocalSettings: true,
    });
    const roundTripped = sshConnectionMetadata.parseJson(sshConnectionMetadata.serialize(value));
    expect(roundTripped).toEqual(value);
    expect(roundTripped?.syncLocalSettings).toBe(true);
  });

  it('keeps syncLocalSettings false-y for shapes written before v4', () => {
    for (const stored of [
      {},
      { version: '1', dependencySelections: { claude: { path: '/bin/claude' } } },
      { version: '2', dependencySelections: { claude: { kind: 'path', path: '/bin/claude' } } },
    ]) {
      const result = sshConnectionMetadata.safeParse(stored);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') continue;
      expect(result.data.syncLocalSettings ?? false).toBe(false);
    }
  });
});
