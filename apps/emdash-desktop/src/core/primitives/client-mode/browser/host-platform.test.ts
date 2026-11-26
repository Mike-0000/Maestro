import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHostPlatformForTesting, loadHostPlatform } from './host-platform';

const mocks = vi.hoisted(() => ({ getPlatform: vi.fn() }));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ getPlatform: mocks.getPlatform }),
}));

vi.mock('@core/primitives/logging/browser/logger', () => ({ log: { warn: vi.fn() } }));

describe('loadHostPlatform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setHostPlatformForTesting(undefined);
  });

  afterEach(() => setHostPlatformForTesting(undefined));

  it('asks the host once and reuses the answer', async () => {
    mocks.getPlatform.mockResolvedValue('linux');

    await expect(loadHostPlatform()).resolves.toBe('linux');
    await expect(loadHostPlatform()).resolves.toBe('linux');
    expect(mocks.getPlatform).toHaveBeenCalledTimes(1);
  });

  it('asks again after a failed call', async () => {
    mocks.getPlatform.mockRejectedValueOnce(new Error('link down')).mockResolvedValue('linux');

    await expect(loadHostPlatform()).rejects.toThrow('link down');
    await expect(loadHostPlatform()).resolves.toBe('linux');
    expect(mocks.getPlatform).toHaveBeenCalledTimes(2);
  });
});
