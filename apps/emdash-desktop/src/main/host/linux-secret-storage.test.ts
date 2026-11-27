import { describe, expect, it } from 'vitest';
import { allowsBasicTextSecretStorage, shouldForceLibsecretBackend } from './linux-secret-storage';

describe('allowsBasicTextSecretStorage', () => {
  it('allows basic_text for the host service started with --password-store=basic', () => {
    expect(
      allowsBasicTextSecretStorage({
        env: { MAESTRO_HOST_SERVICE: '1' },
        passwordStoreSwitch: 'basic',
      })
    ).toBe(true);
  });

  it('refuses a desktop install that fell back to basic_text without the host service', () => {
    expect(allowsBasicTextSecretStorage({ env: {}, passwordStoreSwitch: undefined })).toBe(false);
    expect(allowsBasicTextSecretStorage({ env: {}, passwordStoreSwitch: 'basic' })).toBe(false);
  });

  it('refuses the host service when basic was not asked for explicitly', () => {
    expect(
      allowsBasicTextSecretStorage({
        env: { MAESTRO_HOST_SERVICE: '1' },
        passwordStoreSwitch: undefined,
      })
    ).toBe(false);
    expect(
      allowsBasicTextSecretStorage({
        env: { MAESTRO_HOST_SERVICE: '1' },
        passwordStoreSwitch: 'gnome-libsecret',
      })
    ).toBe(false);
    expect(
      allowsBasicTextSecretStorage({
        env: { MAESTRO_HOST_SERVICE: '0' },
        passwordStoreSwitch: 'basic',
      })
    ).toBe(false);
  });
});

describe('shouldForceLibsecretBackend', () => {
  it('forces libsecret on an unrecognized desktop without relying on D-Bus environment', () => {
    expect(
      shouldForceLibsecretBackend({
        XDG_CURRENT_DESKTOP: 'Hyprland',
      })
    ).toBe(true);
  });

  it('forces libsecret when no desktop is advertised', () => {
    expect(shouldForceLibsecretBackend({})).toBe(true);
  });

  it('returns true on GNOME (harmless — Chromium already selects libsecret there)', () => {
    expect(
      shouldForceLibsecretBackend({
        XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      })
    ).toBe(true);
  });

  it('leaves KDE to its native kwallet backend', () => {
    expect(
      shouldForceLibsecretBackend({
        XDG_CURRENT_DESKTOP: 'KDE',
      })
    ).toBe(false);
    expect(
      shouldForceLibsecretBackend({
        XDG_CURRENT_DESKTOP: 'plasma:KDE',
      })
    ).toBe(false);
    expect(
      shouldForceLibsecretBackend({
        XDG_CURRENT_DESKTOP: 'Plasma',
      })
    ).toBe(false);
    expect(shouldForceLibsecretBackend({ KDE_FULL_SESSION: 'true' })).toBe(false);
    expect(shouldForceLibsecretBackend({ KDE_SESSION_VERSION: '6' })).toBe(false);
  });

  it('does not override an explicit password-store switch', () => {
    expect(
      shouldForceLibsecretBackend(
        {
          XDG_CURRENT_DESKTOP: 'Hyprland',
        },
        { passwordStoreSwitchPresent: true }
      )
    ).toBe(false);
  });
});
