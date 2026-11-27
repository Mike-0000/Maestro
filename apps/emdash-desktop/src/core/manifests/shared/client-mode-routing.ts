import type { desktopDomainContracts } from './domain-contracts';

export type DesktopDomain = keyof typeof desktopDomainContracts;

/**
 * Where one desktop Wire domain runs when a client-mode window drives a remote host.
 *
 * - `host`: what the host answers an owner client inside this domain. `'all'` serves every
 *   endpoint, `'none'` serves nothing, and a list serves only those endpoint paths (relative to
 *   the domain, for example `'attachments.prepareLocalFiles'`).
 * - `client`: what the client's main process does with the renderer's calls. `'forward'` sends
 *   every call to the host, `'local'` answers them all itself, and `'custom'` mixes the two
 *   through an adapter in `src/main/client/`.
 */
export type ClientModeRoute = {
  readonly host: 'all' | 'none' | readonly string[];
  readonly client: 'forward' | 'local' | 'custom';
  readonly note?: string;
};

const FORWARD = { host: 'all', client: 'forward' } as const satisfies ClientModeRoute;
const LOCAL = { host: 'none', client: 'local' } as const satisfies ClientModeRoute;

/**
 * The single source of truth for client mode. A new desktop domain fails typecheck here until it
 * is classified. The host uses it as an allowlist; the client builds its controller bundle from
 * it. See the domain table in `agents/architecture/client-mode.md`.
 */
export const clientModeRouting = {
  account: { ...FORWARD, note: 'OAuth pages open on the client through the opener bridge.' },
  agents: FORWARD,
  appSettings: {
    host: 'all',
    client: 'custom',
    note: 'Forwarded; theme, keyboard and browser changes also apply to the client locally.',
  },
  devPerf: { ...LOCAL, note: 'Local stub with safe defaults.' },
  editor: FORWARD,
  files: FORWARD,
  legacyPort: FORWARD,
  localUpdates: { ...FORWARD, note: 'The host answers for its own install.' },
  logging: { ...LOCAL, note: "Renderer logs go to the client's log file." },
  machines: { ...FORWARD, note: '"This computer" is the host.' },
  projectSettings: FORWARD,
  projectWorkspaces: FORWARD,
  promptLibrary: FORWARD,
  repository: FORWARD,
  remoteAccess: { ...FORWARD, note: "The owner manages the host's listener and devices." },
  search: FORWARD,
  telemetry: FORWARD,
  sourceControl: FORWARD,
  mcp: FORWARD,
  skills: FORWARD,
  agentAddons: FORWARD,
  claudeAccounts: FORWARD,
  clientProfiles: {
    ...LOCAL,
    note: "Profiles of this computer; the page is hidden in client mode and the client's stub has none.",
  },
  terminals: {
    host: 'all',
    client: 'custom',
    note: 'attachments.prepareLocalFiles uploads client files and forwards host paths.',
  },
  mementos: FORWARD,
  notifications: {
    ...FORWARD,
    note: 'OS banners come from the owner bridge and are shown by the client.',
  },
  pullRequests: FORWARD,
  catalog: FORWARD,
  workspaces: FORWARD,
  workspaceRegistry: FORWARD,
  lifecycleScripts: FORWARD,
  projects: FORWARD,
  automations: FORWARD,
  browser: { ...LOCAL, note: 'Webviews live in the client window.' },
  conversations: {
    host: 'all',
    client: 'custom',
    note: 'attachments.prepareLocalFiles uploads client files and forwards host paths.',
  },
  previewServers: { ...FORWARD, note: 'Host loopback URLs are reached through the tunnel proxy.' },
  github: FORWARD,
  integrations: FORWARD,
  issues: FORWARD,
  ssh: FORWARD,
  hosts: FORWARD,
  tasks: FORWARD,
  updates: { ...LOCAL, note: 'Local updater; refuses while the local app runs.' },
  host: {
    host: ['persistDroppedBlob', 'getPlatform'],
    client: 'custom',
    note: 'Window, shell, dialogs and clipboard are the client; dropped blobs land on the host.',
  },
  voice: {
    host: 'all',
    client: 'custom',
    note: 'Forwarded; the global talk keys and openMicrophoneSettings run on the client.',
  },
  conductor: FORWARD,
  talk: FORWARD,
  markdownViewer: FORWARD,
} as const satisfies Record<DesktopDomain, ClientModeRoute>;

const routes: Readonly<Record<string, ClientModeRoute>> = clientModeRouting;

/**
 * Whether the host answers an owner client's call into `domain`. `path` is relative to the
 * domain: a procedure path, or a live topic's ref id (`status.state`) without its key. A path
 * matches a listed endpoint exactly or as a dotted descendant of it.
 */
export function isHostServedPath(domain: string, path: string): boolean {
  if (!Object.hasOwn(routes, domain)) return false;
  const { host } = routes[domain]!;
  if (host === 'all') return true;
  if (host === 'none') return false;
  return host.some((endpoint) => path === endpoint || path.startsWith(`${endpoint}.`));
}

/** The desktop domains whose client-side handling is `mode`. */
export function clientModeDomains(mode: ClientModeRoute['client']): DesktopDomain[] {
  return (Object.keys(clientModeRouting) as DesktopDomain[]).filter(
    (domain) => clientModeRouting[domain].client === mode
  );
}
