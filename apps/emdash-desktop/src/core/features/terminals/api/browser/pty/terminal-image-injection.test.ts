import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { resolveDroppedFile } from './terminal-image-injection';

const mocks = vi.hoisted(() => ({
  getPathForFile: vi.fn<(file: File) => string>(),
  persistDroppedBlob: vi.fn(),
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ persistDroppedBlob: mocks.persistDroppedBlob }),
}));

vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn() },
}));

describe('resolveDroppedFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { electronAPI: { getPathForFile: mocks.getPathForFile } });
    mocks.getPathForFile.mockReturnValue('/Users/me/shot.png');
    mocks.persistDroppedBlob.mockResolvedValue({ success: true, path: '/host/tmp/shot.png' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setClientModeForTesting(undefined);
  });

  it('uses the dropped file path on this computer in local mode', async () => {
    setClientModeForTesting(false);
    const file = new File(['png'], 'shot.png', { type: 'image/png' });

    await expect(resolveDroppedFile(file)).resolves.toBe('/Users/me/shot.png');
    expect(mocks.getPathForFile).toHaveBeenCalledWith(file);
    expect(mocks.persistDroppedBlob).not.toHaveBeenCalled();
  });

  it('persists bytes in local mode only when the file has no stable path', async () => {
    setClientModeForTesting(false);
    mocks.getPathForFile.mockReturnValue('');

    await expect(resolveDroppedFile(new File(['png'], 'shot.png'))).resolves.toBe(
      '/host/tmp/shot.png'
    );
    expect(mocks.persistDroppedBlob).toHaveBeenCalledTimes(1);
  });

  it('always sends the bytes to the host in client mode', async () => {
    setClientModeForTesting(true);
    const file = new File(['png'], 'shot.png', { type: 'image/png' });

    await expect(resolveDroppedFile(file)).resolves.toBe('/host/tmp/shot.png');
    expect(mocks.getPathForFile).not.toHaveBeenCalled();
    expect(mocks.persistDroppedBlob).toHaveBeenCalledWith({
      bytes: new Uint8Array([112, 110, 103]),
      name: 'shot.png',
      mimeType: 'image/png',
    });
  });
});
