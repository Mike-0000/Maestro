import { action, makeObservable, observable } from 'mobx';
import { httpOrigin, originKey } from '@core/primitives/browser/api';

/** Matches the cap main applies to a browser's user origins. */
const MAX_ORIGINS = 16;

/**
 * Local origins the developer opened in a browser themselves, by browser id: typed into its
 * address bar or picked on its start page. These, beside the task's detected dev servers, are the
 * origins agents may open in that browser. Only a user gesture records one: a page navigating
 * itself, the conductor or an agent never does, so none of them can widen what agents may open.
 * Kept in memory only.
 */
export class BrowserUserOrigins {
  readonly origins = observable.map<string, readonly string[]>();

  constructor() {
    makeObservable(this, { record: action, forget: action });
  }

  /** The developer opened `url` in this browser; a local origin is recorded. */
  record(browserId: string, url: string): void {
    const origin = httpOrigin(url);
    if (!origin || !originKey(origin)?.includes('//loopback:')) return;
    const current = this.origins.get(browserId) ?? [];
    if (current.includes(origin)) return;
    this.origins.set(browserId, [...current, origin].slice(-MAX_ORIGINS));
  }

  get(browserId: string): readonly string[] {
    return this.origins.get(browserId) ?? [];
  }

  forget(browserId: string): void {
    this.origins.delete(browserId);
  }
}

export const browserUserOrigins = new BrowserUserOrigins();
