import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternalForUser, setExternalOpenerOverride } from './external-opener';

const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => {}));

vi.mock('electron', () => ({ shell: { openExternal } }));

describe('external opener', () => {
  afterEach(() => {
    setExternalOpenerOverride(undefined);
    openExternal.mockClear();
  });

  it('opens with the OS browser by default, exactly as shell.openExternal', async () => {
    await openExternalForUser('https://example.com/a?b=c', { loopbackPort: 5555 });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a?b=c');
  });

  it('routes to the override while one is set, and back once it is cleared', async () => {
    const opener = vi.fn(async () => {});
    setExternalOpenerOverride(opener);
    await openExternalForUser('https://example.com', { loopbackPort: 4000 });
    expect(opener).toHaveBeenCalledWith('https://example.com', { loopbackPort: 4000 });
    expect(openExternal).not.toHaveBeenCalled();

    setExternalOpenerOverride(undefined);
    await openExternalForUser('https://example.com');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('passes the override failure to the caller', async () => {
    setExternalOpenerOverride(async () => {
      throw new Error('no client');
    });
    await expect(openExternalForUser('https://example.com')).rejects.toThrow('no client');
  });
});
