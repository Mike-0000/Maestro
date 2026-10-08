import { makeAutoObservable } from 'mobx';

export type Route =
  | { name: 'home' }
  | { name: 'agent'; conversationId: string }
  | { name: 'new' }
  | { name: 'settings' };

export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'agent' && segments[1]) {
    return { name: 'agent', conversationId: safeDecode(segments[1]) };
  }
  if (segments[0] === 'new' && segments.length === 1) return { name: 'new' };
  if (segments[0] === 'settings' && segments.length === 1) return { name: 'settings' };
  return { name: 'home' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'home':
      return '/';
    case 'agent':
      return `/agent/${encodeURIComponent(route.conversationId)}`;
    case 'new':
      return '/new';
    case 'settings':
      return '/settings';
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

type HistoryState = { depth: number; under?: string };

function readState(): HistoryState | null {
  const state: unknown = window.history.state;
  if (typeof state !== 'object' || state === null) return null;
  const { depth, under } = state as Partial<HistoryState>;
  if (typeof depth !== 'number') return null;
  return { depth, under: typeof under === 'string' ? under : undefined };
}

/**
 * History-backed routing, so the browser's back button and the system back gesture do what the
 * on-screen back button does, and every screen has a URL that survives a reload.
 */
export class Router {
  route: Route;
  /** Entries this app has pushed below the current one; zero on a fresh deep link. */
  depth: number;
  /** How the current route was reached; a screen arrived at by going back should not animate in. */
  lastNavigation: 'push' | 'pop' | 'replace' = 'replace';
  /** The page a sheet route (`/new`, `/settings`) was opened over, so it stays visible behind. */
  under: Route;

  constructor() {
    this.route = parseRoute(window.location.pathname);
    const state = readState();
    this.depth = state?.depth ?? 0;
    this.under = state?.under ? parseRoute(state.under) : { name: 'home' };
    makeAutoObservable(this);
    window.addEventListener('popstate', () => this.handlePop());
  }

  /** The page shown in the main area: sheets do not replace the page beneath them. */
  get page(): Route {
    return this.route.name === 'new' || this.route.name === 'settings' ? this.under : this.route;
  }

  push(route: Route): void {
    if (routePath(route) === routePath(this.route)) return;
    const under = this.page;
    this.depth += 1;
    this.under = under;
    window.history.pushState(this.stateFor(under), '', routePath(route));
    this.route = route;
    this.lastNavigation = 'push';
  }

  replace(route: Route): void {
    const under = route.name === 'new' || route.name === 'settings' ? this.under : this.page;
    this.under = under;
    window.history.replaceState(this.stateFor(under), '', routePath(route));
    this.route = route;
    this.lastNavigation = 'replace';
  }

  /** Leaves the current screen: back through history when we came from inside the app. */
  back(fallback: Route = { name: 'home' }): void {
    if (this.depth > 0) window.history.back();
    else this.replace(fallback);
  }

  private stateFor(under: Route): HistoryState {
    return { depth: this.depth, under: routePath(under) };
  }

  private handlePop(): void {
    const state = readState();
    this.depth = state?.depth ?? 0;
    this.under = state?.under ? parseRoute(state.under) : { name: 'home' };
    this.route = parseRoute(window.location.pathname);
    this.lastNavigation = 'pop';
  }
}
