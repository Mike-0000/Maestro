import {
  formatDirectPreviewServerHost,
  type PreviewServer,
} from '@core/primitives/preview-servers/api';

export function formatPreviewUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

export function formatPreviewServerLabel(server: PreviewServer): string {
  if (server.kind === 'forwarded') {
    return server.localPort === undefined
      ? `remote ${server.remotePort}`
      : `${server.remotePort} -> ${server.localPort}`;
  }
  const host = formatDirectPreviewServerHost(server.host);
  return formatPreviewUrl(`${server.protocol}//${host}:${server.port}${server.urlPath}`);
}

export function previewServerStatusLabel(server: PreviewServer): string {
  switch (server.status.kind) {
    case 'ready':
      return server.kind === 'forwarded' ? 'Forwarded' : 'Ready';
    case 'starting':
      return 'Starting';
    case 'not-listening':
      return 'Remote port not listening yet';
    case 'reconnecting':
      return 'Reconnecting';
    case 'failed':
      return 'Failed';
  }
}

/**
 * Text tone for a preview pill (design brief 2.6): no tinted fills. A live server reads in full
 * strength, a pending one muted; the state itself is carried by the pill's glyph and its title.
 */
export function previewServerStatusClasses(server: PreviewServer): string {
  switch (server.status.kind) {
    case 'ready':
      return 'text-foreground';
    case 'starting':
    case 'not-listening':
    case 'reconnecting':
    case 'failed':
      return 'text-foreground-muted';
  }
}
