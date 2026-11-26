import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_MODE_RENDERER_SEARCH, isClientModeSearch } from '../api/client-mode-search';
import { isClientMode, setClientModeForTesting } from './client-mode';

describe('client mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setClientModeForTesting(undefined);
  });

  it('is off for the renderer URLs the local app uses', () => {
    for (const search of ['', '?', '?task=1', '?maestroClient=0', '?maestroClient=true']) {
      expect(isClientModeSearch(search)).toBe(false);
    }
  });

  it('is on only for the search the client process loads', () => {
    expect(isClientModeSearch(CLIENT_MODE_RENDERER_SEARCH)).toBe(true);
    expect(isClientModeSearch('?a=b&maestroClient=1')).toBe(true);
  });

  it('is off without a location, as in the main process', () => {
    expect(isClientMode()).toBe(false);
  });

  it('reads the page URL once', () => {
    vi.stubGlobal('location', { search: '?maestroClient=1' });
    expect(isClientMode()).toBe(true);
    vi.stubGlobal('location', { search: '' });
    expect(isClientMode()).toBe(true);
  });

  it('can be forced in tests', () => {
    setClientModeForTesting(true);
    expect(isClientMode()).toBe(true);
    setClientModeForTesting(false);
    expect(isClientMode()).toBe(false);
  });
});
