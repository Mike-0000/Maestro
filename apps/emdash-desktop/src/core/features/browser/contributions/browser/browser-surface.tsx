import { EmptyState } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import {
  browserLoadErrorCode,
  describeBrowserLoadError,
  type BrowserLoadErrorPresentation,
} from '@core/features/browser/browser/browser-load-error';
import { decideBrowserReload } from '@core/features/browser/browser/browser-navigation-controls';
import { BrowserStartPage } from '@core/features/browser/browser/browser-start-page';
import { BrowserToolbar } from '@core/features/browser/browser/browser-toolbar';
import {
  canOpenBrowserUrlExternally,
  openBrowserUrlExternally,
} from '@core/features/browser/browser/browser-toolbar-actions';
import { bindBrowserWebviewEvents } from '@core/features/browser/browser/browser-webview-events';
import {
  createBrowserWebviewAdapter,
  type BrowserWebviewAdapter,
  type BrowserWebviewElement,
} from '@core/features/browser/browser/browser-webview-types';
import { normalizeBrowserUrl, normalizeBrowserZoomFactor } from '@core/primitives/browser/api';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { cn } from '@core/primitives/styling/browser/cn';

const WEBVIEW_ALLOW_POPUPS_ATTRIBUTE = 'true' as unknown as boolean;

export type BrowserSurfaceProps = {
  browserId: string;
  visible: boolean;
  /** Dev-server URLs offered on the start page. */
  devServerUrls: string[];
  /** Ctrl+Tab from inside the page; omitted where there are no tabs to cycle. */
  onCycleTab?: (direction: 'next' | 'previous') => void;
  /** Hides the profile switcher (canvas app browsers stay isolated per task). */
  profileLocked?: boolean;
};

/**
 * A browser session's toolbar and webview without workbench context, so both task tabs and the
 * canvas can host it. The webview must never move in the DOM once mounted: Electron reloads a
 * guest whose element is re-parented.
 */
export const BrowserSurface = observer(function BrowserSurface({
  browserId,
  visible,
  devServerUrls,
  onCycleTab,
  profileLocked = false,
}: BrowserSurfaceProps) {
  const session = browserSessionStore.getSession(browserId);
  const onCycleTabRef = useRef(onCycleTab);
  onCycleTabRef.current = onCycleTab;
  const cyclesTabs = onCycleTab !== undefined;
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const focusUrlRef = useRef<() => void>(() => {});
  const [adapter, setAdapter] = useState<BrowserWebviewAdapter | null>(null);
  const [webviewElement, setWebviewElement] = useState<BrowserWebviewElement | null>(null);
  const [webviewMount, setWebviewMount] = useState<{
    browserId: string;
    partition: string;
    src: string;
    revision: number;
  } | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const sessionBrowserId = session?.browserId;
  const sessionPartition = session?.partition;
  const showStartPage = session?.currentUrl === 'about:blank' && !session.isLoading;
  const loadError = session && !session.isLoading ? session.loadError : undefined;
  const loadErrorUrl = loadError ? (loadError.url ?? session?.currentUrl ?? '') : '';
  const loadErrorPresentation = useMemo<BrowserLoadErrorPresentation | undefined>(
    () => (loadError ? describeBrowserLoadError(loadError, loadErrorUrl) : undefined),
    [loadError, loadErrorUrl]
  );
  const canOpenLoadErrorExternal = useMemo(
    () => (loadError ? canOpenBrowserUrlExternally(loadErrorUrl) : false),
    [loadError, loadErrorUrl]
  );

  useEffect(() => {
    if (!sessionBrowserId || !sessionPartition || !session) {
      setWebviewMount(null);
      return;
    }
    setWebviewMount((current) => {
      if (current?.browserId === sessionBrowserId && current.partition === sessionPartition) {
        return current;
      }
      return {
        browserId: sessionBrowserId,
        partition: sessionPartition,
        src: session.currentUrl,
        revision: 0,
      };
    });
  }, [session, sessionBrowserId, sessionPartition]);

  useEffect(() => {
    if (!sessionBrowserId || !sessionPartition) return;
    let disposed = false;
    setIsRegistered(false);
    void getBrowserClient()
      .then((client) =>
        client.registerSession({
          browserId: sessionBrowserId,
          partition: sessionPartition,
        })
      )
      .then((result) => {
        if (!disposed) setIsRegistered(result.success);
      });
    return () => {
      disposed = true;
      setIsRegistered(false);
    };
  }, [sessionBrowserId, sessionPartition]);

  useEffect(() => {
    return () => {
      void getBrowserClient().then((client) => client.setActiveBrowser({ browserId: null }));
    };
  }, []);

  useEffect(() => {
    if (!visible || !sessionBrowserId || adapter === null) return;
    void getBrowserClient().then((client) =>
      client.setActiveBrowser({ browserId: sessionBrowserId })
    );
  }, [adapter, sessionBrowserId, visible]);

  useEffect(() => {
    if (!visible || !sessionBrowserId || !cyclesTabs) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getHostClient().then(async (client) => {
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (
            event.type !== 'tab-navigation-shortcut' ||
            event.source.browserId !== sessionBrowserId
          ) {
            return;
          }
          onCycleTabRef.current?.(event.direction);
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [cyclesTabs, sessionBrowserId, visible]);

  const webviewProps = useMemo(() => {
    if (!webviewMount) return null;
    return {
      src: webviewMount.src,
      partition: webviewMount.partition,
      allowpopups: WEBVIEW_ALLOW_POPUPS_ATTRIBUTE,
      'data-browser-id': webviewMount.browserId,
    };
  }, [webviewMount]);

  const loadUrl = useCallback(
    (url: string) => {
      if (!sessionBrowserId) return;
      browserSessionStore.updateSession(sessionBrowserId, {
        currentUrl: url,
        faviconUrl: null,
        isLoading: true,
        loadError: null,
      });
      if (adapter) {
        void adapter.loadUrl(url);
        return;
      }
      setWebviewMount((current) => {
        if (!current) return current;
        return {
          ...current,
          src: url,
          revision: current.revision + 1,
        };
      });
    },
    [adapter, sessionBrowserId]
  );

  const navigateTo = useCallback(
    (url: string): boolean => {
      const normalized = normalizeBrowserUrl(url);
      if (!normalized.ok) return false;
      loadUrl(normalized.url);
      return true;
    },
    [loadUrl]
  );

  // An address asked for from outside the toolbar (a task's conductor) loads as if typed there.
  const requestedUrl = browserSessionStore.navigationRequests.get(browserId);
  useEffect(() => {
    if (!requestedUrl || !sessionBrowserId) return;
    browserSessionStore.takeNavigationRequest(sessionBrowserId);
    navigateTo(requestedUrl);
  }, [requestedUrl, sessionBrowserId, navigateTo]);

  const goBack = useCallback(() => {
    if (!adapter?.canGoBack()) return;
    adapter.goBack();
  }, [adapter]);

  const goForward = useCallback(() => {
    if (!adapter?.canGoForward()) return;
    adapter.goForward();
  }, [adapter]);

  const reload = useCallback(() => {
    if (!session) return;
    const decision = decideBrowserReload({
      currentUrl: session.currentUrl,
      isLoading: session.isLoading,
      hasAdapter: adapter !== null,
    });
    if (decision.kind === 'reload-adapter') adapter?.reload();
    if (decision.kind === 'stop-adapter') adapter?.stop();
    if (decision.kind === 'retry-url') loadUrl(decision.url);
  }, [adapter, loadUrl, session]);

  const forceReload = useCallback(() => {
    if (adapter) {
      adapter.reloadIgnoringCache();
      return;
    }
    reload();
  }, [adapter, reload]);

  const setZoomFactor = useCallback(
    (factor: number) => {
      if (!sessionBrowserId) return;
      const zoomFactor = normalizeBrowserZoomFactor(factor);
      browserSessionStore.updateSession(sessionBrowserId, {
        zoomFactor,
      });
      adapter?.setZoomFactor(zoomFactor);
    },
    [adapter, sessionBrowserId]
  );

  // Must stay referentially stable: React re-invokes inline ref callbacks with
  // null + node on every render, which would wipe the adapter until the next
  // dom-ready and break everything adapter-backed (zoom, stop, force reload).
  const attachWebview = useCallback((node: Element | null) => {
    const next = node as BrowserWebviewElement | null;
    if (webviewRef.current === next) return;
    webviewRef.current = next;
    setWebviewElement(next);
    setAdapter(null);
  }, []);

  useEffect(() => {
    if (!sessionBrowserId || !webviewElement) return;
    return bindBrowserWebviewEvents(sessionBrowserId, webviewElement, {
      onDomReady: () => {
        if (webviewRef.current !== webviewElement) return;
        // Browsers can share profile partitions, so the main process cannot infer
        // which browser a webview belongs to; bind it explicitly.
        void getBrowserClient().then((client) =>
          client.bindWebContents({
            browserId: sessionBrowserId,
            webContentsId: webviewElement.getWebContentsId(),
          })
        );
        setAdapter(createBrowserWebviewAdapter(webviewElement));
      },
    });
  }, [sessionBrowserId, webviewElement]);

  useEffect(() => {
    if (!sessionBrowserId) return;
    return browserControlsRegistry.register(sessionBrowserId, {
      adapter,
      focusUrl: () => focusUrlRef.current(),
    });
  }, [adapter, sessionBrowserId]);

  const showsWebview = !loadError && !showStartPage && webviewProps !== null && isRegistered;

  if (!session) {
    return (
      <div className="surface-paper h-full min-h-0 bg-(--em-surface)">
        <EmptyState
          bare
          label="Browser session unavailable"
          description="Close this tab and open a new browser."
        />
      </div>
    );
  }

  return (
    <div className="surface-paper flex h-full min-h-0 flex-col bg-(--em-surface)">
      <BrowserToolbar
        session={session}
        adapter={adapter}
        autoFocusUrl={showStartPage}
        onNavigate={navigateTo}
        onGoBack={goBack}
        onGoForward={goForward}
        onReload={reload}
        onForceReload={forceReload}
        onSetZoomFactor={setZoomFactor}
        onFocusUrl={(focus) => {
          focusUrlRef.current = focus;
        }}
        profileLocked={profileLocked}
      />
      {/*
       * The page area. While a page is up it is a framed white canvas (forced light, as web pages
       * expect) inset on the paper; the start page, errors and the wait sit on the app's own
       * surface. The element itself never changes, so the webview is never re-parented.
       */}
      <div
        className={cn(
          'min-h-0 flex-1',
          showsWebview &&
            'emlight mx-2 mb-2 overflow-hidden rounded-lg bg-background ring-1 ring-border-subtle'
        )}
      >
        {loadError && loadErrorPresentation ? (
          <BrowserLoadErrorView
            url={loadErrorUrl}
            presentation={loadErrorPresentation}
            code={browserLoadErrorCode(loadError)}
            canOpenExternal={canOpenLoadErrorExternal}
            onReload={reload}
            onOpenExternal={() => openBrowserUrlExternally(loadErrorUrl)}
          />
        ) : showStartPage ? (
          <BrowserStartPage devServerUrls={devServerUrls} onOpenUrl={navigateTo} />
        ) : webviewProps && isRegistered ? (
          <webview
            key={`${webviewMount?.browserId ?? 'browser'}:${webviewMount?.partition ?? 'partition'}:${webviewMount?.revision ?? 0}`}
            ref={attachWebview}
            {...webviewProps}
            className="h-full w-full bg-background"
          />
        ) : (
          <EmptyState bare tone="loading" label="Preparing browser session…" />
        )}
      </div>
    </div>
  );
});

function BrowserLoadErrorView({
  presentation,
  code,
  url,
  canOpenExternal,
  onReload,
  onOpenExternal,
}: {
  presentation: BrowserLoadErrorPresentation;
  code: string | null;
  url: string;
  canOpenExternal: boolean;
  onReload: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <EmptyState
      bare
      tone="error"
      label={presentation.heading}
      description={<span title={url}>{presentation.detail}</span>}
      details={code ?? undefined}
      action={
        <span className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <Button type="button" variant="text" onClick={onReload}>
            Reload
          </Button>
          <Button type="button" variant="text" disabled={!canOpenExternal} onClick={onOpenExternal}>
            Open externally
          </Button>
        </span>
      }
    />
  );
}
