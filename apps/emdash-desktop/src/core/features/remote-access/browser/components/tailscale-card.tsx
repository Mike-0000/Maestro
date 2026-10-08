import { Pill } from '@emdash/ui/react/components';
import { SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Input, Spinner, toast } from '@emdash/ui/react/primitives';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { RemoteAccessTailscale } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { cn } from '@core/primitives/styling/browser/cn';
import { tailscaleStage } from '../remote-access-format';
import { useRemoteAccessTailscale } from '../use-remote-access-tailscale';
import { CopyButton } from './copy-button';
import { errorMessage, RemoteAccessRow } from './remote-access-row';

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const ADDRESS_INPUT_ID = 'remote-access-tailscale-address';

/** Tailscale's HTTPS forwarding to the listener: what is missing, or the address it serves. */
export function TailscaleCard({ listenerKey }: { listenerKey: string }) {
  const { tailscale, isFetching, error, refresh, adopt } = useRemoteAccessTailscale(
    listenerKey,
    true
  );
  const [changing, setChanging] = useState(false);
  const busy = changing || isFetching;

  const setServe = async (enabled: boolean) => {
    setChanging(true);
    const title = enabled
      ? 'Could not serve over Tailscale'
      : 'Could not stop serving over Tailscale';
    try {
      const result = await (await getRemoteAccessClient()).setTailscaleServe({ enabled });
      if (result.success) {
        adopt(result.data);
      } else {
        toast.error(title, { description: result.error.message });
        refresh();
      }
    } catch (error) {
      toast.error(title, { description: errorMessage(error) });
    } finally {
      setChanging(false);
    }
  };

  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      icon
      className="text-foreground-muted"
      aria-label="Check Tailscale again"
      disabled={busy}
      onClick={refresh}
    >
      <RefreshCwIcon className={cn(isFetching && 'animate-spin')} />
    </Button>
  );

  return (
    <SettingsSection title="Tailscale">
      {tailscale === undefined ? (
        error ? (
          <RemoteAccessRow
            title="Could not check Tailscale"
            description={errorMessage(error)}
            actions={refreshButton}
          />
        ) : (
          <RemoteAccessRow
            title="Tailscale"
            description={
              <span className="flex items-center gap-2">
                <Spinner size="sm" />
                Checking Tailscale…
              </span>
            }
          />
        )
      ) : (
        <TailscaleState
          tailscale={tailscale}
          busy={busy}
          refresh={refreshButton}
          onServe={(enabled) => void setServe(enabled)}
        />
      )}
    </SettingsSection>
  );
}

function TailscaleState({
  tailscale,
  busy,
  refresh,
  onServe,
}: {
  tailscale: RemoteAccessTailscale;
  busy: boolean;
  refresh: ReactNode;
  onServe: (enabled: boolean) => void;
}) {
  const stage = tailscaleStage(tailscale);
  const detail = tailscale.detail ? <span>{tailscale.detail}</span> : null;

  if (stage === 'missing') {
    return (
      <RemoteAccessRow
        title="Tailscale was not found"
        description={
          <span className="flex flex-col gap-1">
            <span>
              Tailscale is a private network between your own devices. Install it on this computer
              and on the device you want to connect from (tailscale.com), then check again.
            </span>
            {detail}
          </span>
        }
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void openExternal(TAILSCALE_DOWNLOAD_URL)}
            >
              <ExternalLinkIcon />
              Get Tailscale
            </Button>
            {refresh}
          </>
        }
      />
    );
  }

  if (stage === 'signed-out') {
    return (
      <RemoteAccessRow
        title="Tailscale is not connected"
        description={tailscale.detail ?? 'Sign in to Tailscale on this computer, then check again.'}
        actions={refresh}
      />
    );
  }

  if (stage === 'ready') {
    return (
      <RemoteAccessRow
        title="Tailscale is ready"
        description={
          <span className="flex flex-col gap-1">
            <span>
              {tailscale.dnsName
                ? `Serve remote access at https://${tailscale.dnsName}, reachable only from devices signed in to your tailnet.`
                : 'Serve remote access over HTTPS, reachable only from devices signed in to your tailnet.'}
            </span>
            {detail}
          </span>
        }
        actions={
          <>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => onServe(true)}
            >
              Serve over Tailscale HTTPS
            </Button>
            {refresh}
          </>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <RemoteAccessRow
        title={
          <>
            Serving over Tailscale HTTPS
            <Pill variant="success" dot>
              Serving
            </Pill>
          </>
        }
        description={
          <span className="flex flex-col gap-1">
            <label htmlFor={ADDRESS_INPUT_ID}>
              Open this address on your other devices. It works only for devices signed in to your
              tailnet.
            </label>
            {detail}
          </span>
        }
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onServe(false)}
            >
              Stop serving
            </Button>
            {refresh}
          </>
        }
      />
      <div className="flex items-center gap-2">
        <Input
          id={ADDRESS_INPUT_ID}
          readOnly
          value={tailscale.url ?? ''}
          spellCheck={false}
          className="min-w-0 flex-1 font-mono"
          onFocus={(event) => event.currentTarget.select()}
        />
        <CopyButton text={tailscale.url ?? ''} label="address" />
      </div>
    </div>
  );
}
