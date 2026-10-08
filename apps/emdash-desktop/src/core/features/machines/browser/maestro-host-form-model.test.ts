import { describe, expect, it } from 'vitest';
import type { SshConfig } from '@core/primitives/ssh/api';
import {
  maestroHostEndpointLabel,
  maestroHostFormDefaults,
  validateMaestroHostForm,
  type MaestroHostFormValues,
} from './maestro-host-form-model';

const machine: SshConfig = {
  id: 'maestro-1',
  name: 'Studio',
  host: 'my-pc.tailnet.ts.net',
  port: 443,
  username: '',
  authType: 'agent',
  transport: 'maestro',
  maestro: { url: 'https://my-pc.tailnet.ts.net', hostId: 'host-1', cfAccessClientId: 'id.access' },
};

const values = (overrides: Partial<MaestroHostFormValues> = {}): MaestroHostFormValues => ({
  url: 'https://my-pc.tailnet.ts.net',
  code: '123456',
  cfAccessClientId: '',
  cfAccessClientSecret: '',
  ...overrides,
});

describe('Maestro host form model', () => {
  it('prefills an existing machine without any secret', () => {
    expect(maestroHostFormDefaults(machine)).toEqual({
      url: 'https://my-pc.tailnet.ts.net',
      code: '',
      cfAccessClientId: 'id.access',
      cfAccessClientSecret: '',
    });
    expect(maestroHostFormDefaults()).toEqual(values({ url: '', code: '' }));
  });

  it('accepts a complete form for each purpose', () => {
    expect(validateMaestroHostForm(values(), 'add')).toBeNull();
    expect(validateMaestroHostForm(values({ code: '' }), 'check')).toBeNull();
    expect(validateMaestroHostForm(values({ code: '' }), 'edit')).toBeNull();
    expect(validateMaestroHostForm(values({ url: '' }), 'repair')).toBeNull();
  });

  it('requires a usable address except when only pairing again', () => {
    expect(validateMaestroHostForm(values({ url: ' ' }), 'add')).toBe(
      'Enter the address of the Maestro host.'
    );
    expect(validateMaestroHostForm(values({ url: 'ftp://example.com' }), 'check')).toBe(
      'The address must start with http:// or https://.'
    );
  });

  it('requires a pairing code to pair', () => {
    for (const purpose of ['add', 'repair'] as const) {
      expect(validateMaestroHostForm(values({ code: '  ' }), purpose)).toBe(
        'Enter the pairing code shown by the host.'
      );
    }
  });

  it('requires a client ID for a Cloudflare Access secret', () => {
    expect(validateMaestroHostForm(values({ cfAccessClientSecret: 'shh' }), 'add')).toBe(
      'Enter the Cloudflare Access client ID that goes with the client secret.'
    );
    expect(
      validateMaestroHostForm(
        values({ cfAccessClientId: 'id.access', cfAccessClientSecret: '' }),
        'edit'
      )
    ).toBeNull();
  });

  it('labels a machine by the address it is reached at', () => {
    expect(maestroHostEndpointLabel(machine)).toBe('https://my-pc.tailnet.ts.net');
    expect(maestroHostEndpointLabel({ ...machine, maestro: undefined })).toBe(
      'my-pc.tailnet.ts.net'
    );
  });
});
