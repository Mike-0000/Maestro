import { describe, expect, it } from 'vitest';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import { ownerHostWireContract } from './owner-contract';

describe('ownerHostWireContract', () => {
  it('nests the desktop contract under desktop', () => {
    expect(ownerHostWireContract.desktop.remoteAccess.status.id).toBe(
      'desktop.remoteAccess.status'
    );
    expect(ownerHostWireContract.desktop.host.events.id).toBe('desktop.host.events');
    expect(ownerHostWireContract.session.events.id).toBe('session.events');
    expect(ownerHostWireContract.bridge.notifications.id).toBe('bridge.notifications');
  });

  it('leaves the local desktop contract untouched', () => {
    expect(desktopWireContract.remoteAccess.status.id).toBe('remoteAccess.status');
    expect(desktopWireContract.host.events.id).toBe('host.events');
  });
});
