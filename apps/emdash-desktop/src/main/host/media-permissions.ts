import { session, type WebContents } from 'electron';
import { log } from '@main/lib/logger';

/**
 * Scopes media (microphone/camera) permission in the app's own session: only the main window may
 * capture, and only audio (voice commands). Other permissions keep Electron's default behaviour for
 * this session; in-app browser tabs use their own sessions with their own stricter handlers.
 */
export function restrictMediaPermissions(isAppWindow: (contents: WebContents) => boolean): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true);
      return;
    }
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
    const granted = audioOnly && isAppWindow(contents);
    if (!granted) log.warn('Denied media permission', { mediaTypes, url: contents.getURL() });
    callback(granted);
  });
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== 'media') return true;
    const audio = details.mediaType === 'audio' || details.mediaType === undefined;
    return audio && contents !== null && isAppWindow(contents);
  });
}
