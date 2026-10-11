import { EmptyState, Markdown } from '@emdash/ui/react/components';
import { toast } from '@emdash/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import { watchFileContent } from '@core/features/files/api/browser/file-content';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { log } from '@core/primitives/logging/browser/logger';
import { cn } from '@core/primitives/styling/browser/cn';
import { getMarkdownViewerClient } from '../../api/browser/client';
import { openMarkdownPath } from '../../api/browser/open-markdown-doc';
import type { MarkdownDoc } from '../../api/contract';
import { isMarkdownPath, localReferencePath } from '../../api/markdown-paths';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly content: string }
  | { readonly status: 'unavailable'; readonly message: string };

const LOADING: ViewState = { status: 'loading' };

/**
 * A Markdown file, rendered read-only and kept current with the file on disk. Every read is a
 * checked read in the main process (`MarkdownAccess`), so a window restored from an earlier run
 * shows nothing the viewer may no longer show. Works in any view: the canvas document window and
 * the task-view tab both mount it.
 */
export function MarkdownDocView({
  doc,
  className,
}: {
  doc: Pick<MarkdownDoc, 'projectId' | 'workspaceId' | 'taskId' | 'path'>;
  className?: string;
}) {
  const { projectId, workspaceId, taskId, path } = doc;
  const [state, setState] = useState<ViewState>(LOADING);

  useEffect(() => {
    let disposed = false;
    let reading = false;
    let changedWhileReading = false;
    let stopWatching: (() => void) | undefined;
    setState(LOADING);

    const read = async () => {
      if (reading) {
        changedWhileReading = true;
        return;
      }
      reading = true;
      try {
        do {
          changedWhileReading = false;
          const client = await getMarkdownViewerClient();
          const result = await client.read({ projectId, workspaceId, path });
          if (disposed) return;
          const next: ViewState = result.success
            ? { status: 'ready', content: result.data.content }
            : { status: 'unavailable', message: result.error.message };
          setState((current) => (sameState(current, next) ? current : next));
        } while (changedWhileReading);
      } catch (error: unknown) {
        log.warn('markdown viewer: reading a file failed', { error });
        if (!disposed) setState({ status: 'unavailable', message: 'The file could not be read.' });
      } finally {
        reading = false;
      }
    };

    void read();
    // The files runtime watches the file on disk; each change it reports is read again here.
    try {
      void watchFileContent(hostFileRefFromNativePath(path), () => void read())
        .then((stop) => {
          if (disposed) stop();
          else stopWatching = stop;
        })
        .catch((error: unknown) => log.warn('markdown viewer: watching a file failed', { error }));
    } catch (error: unknown) {
      log.warn('markdown viewer: watching a file failed', { error });
    }
    return () => {
      disposed = true;
      stopWatching?.();
    };
  }, [projectId, workspaceId, path]);

  const resolveImage = useCallback(
    async (src: string): Promise<string | null> => {
      if (/^data:image\//iu.test(src)) return src;
      try {
        const client = await getMarkdownViewerClient();
        const result = await client.readImage({ projectId, workspaceId, from: path, src });
        return result.success ? result.data.dataUrl : null;
      } catch {
        return null;
      }
    },
    [projectId, workspaceId, path]
  );

  // Web links fall through to the app's open-external flow. Every other link is claimed here, so
  // none opens a browser window of its own: a link to another Markdown file opens that file.
  const openLocalLink = useCallback(
    (href: string): boolean => {
      if (/^https?:\/\//iu.test(href)) return false;
      const target = localReferencePath(href);
      if (!target) return true;
      if (!isMarkdownPath(target)) {
        toast('Only links to Markdown files open in the viewer');
        return true;
      }
      void openMarkdownPath({ projectId, workspaceId, taskId }, target, { from: path }).then(
        (opened) => {
          if (!opened) toast.error('That file cannot be shown', { description: target });
        }
      );
      return true;
    },
    [projectId, workspaceId, taskId, path]
  );
  const openLink = useMarkdownLinkOpener(openLocalLink);

  if (state.status === 'loading')
    return <div className={cn('h-full bg-(--em-surface)', className)} />;
  if (state.status === 'unavailable') {
    return (
      <div className={cn('h-full bg-(--em-surface)', className)}>
        <EmptyState label="This file cannot be shown" description={state.message} />
      </div>
    );
  }
  return (
    <div
      className={cn('h-full overflow-y-auto bg-(--em-surface)', className)}
      // A middle click would follow the link into a window of its own; clicks are handled above.
      onAuxClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
      }}
    >
      <Markdown
        content={state.content}
        variant="full"
        className="w-full max-w-3xl px-8 py-8"
        resolveImage={resolveImage}
        onOpenLink={openLink}
      />
    </div>
  );
}

function sameState(a: ViewState, b: ViewState): boolean {
  if (a.status === 'ready' && b.status === 'ready') return a.content === b.content;
  if (a.status === 'unavailable' && b.status === 'unavailable') return a.message === b.message;
  return a.status === b.status;
}
