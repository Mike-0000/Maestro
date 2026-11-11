import { EmptyState } from '@emdash/ui/react/components';
import { SectionLabel } from '@emdash/ui/react/primitives';
import { Globe } from 'lucide-react';

/**
 * What a new browser tab shows before it loads anything: the task's local dev servers as quiet
 * rows to open, or one sentence on how to start when there are none.
 */
export function BrowserStartPage({
  devServerUrls,
  onOpenUrl,
}: {
  devServerUrls: string[];
  onOpenUrl: (url: string) => void;
}) {
  const localUrls = devServerUrls.filter(isLocalUrl);

  if (localUrls.length === 0) {
    return (
      <EmptyState
        bare
        label="Nothing open yet"
        description="Type an address above. Dev servers this task starts show up here too."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 justify-center overflow-auto px-6 pt-[18vh] pb-6">
      <div className="flex w-full max-w-md flex-col gap-2">
        <SectionLabel as="h2" className="px-3">
          Local servers
        </SectionLabel>
        <div className="flex flex-col">
          {localUrls.map((url) => (
            <button
              key={url}
              type="button"
              className="group flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => onOpenUrl(url)}
            >
              <Globe className="size-4 shrink-0 text-foreground-passive group-hover:text-foreground-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {formatServerTitle(url)}
                </span>
                <span className="block truncate text-xs text-foreground-passive">
                  {formatServerAddress(url)}
                </span>
              </span>
              <span className="shrink-0 text-xs text-foreground-passive opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                Open
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function formatServerAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

function formatServerTitle(url: string): string {
  const address = formatServerAddress(url);
  if (address.startsWith('localhost:')) return `Port ${address.slice('localhost:'.length)}`;
  if (address.startsWith('127.0.0.1:')) return `Port ${address.slice('127.0.0.1:'.length)}`;
  return address;
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
