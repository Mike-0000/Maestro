import { EmptyState } from '@emdash/ui/react/components';
import { PageLayout } from '@emdash/ui/react/patterns';
import { Button, Field, Input, Spinner, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, MonitorIcon, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { getClientProfilesClient } from '@core/features/client-profiles/api/browser/client';
import type { ClientProfile } from '@core/features/client-profiles/api/contract';
import { isClientMode } from '@core/primitives/client-mode/browser/client-mode';
import { cn } from '@core/primitives/styling/browser/cn';

const NAME_INPUT_ID = 'client-profiles-name';
const NAME_HINT_ID = 'client-profiles-name-hint';
const NAME_ERROR_ID = 'client-profiles-name-error';

const PROFILES_QUERY_KEY = ['clientProfiles', 'list'] as const;

/** The display name of a profile: "Default" for the unnamed one, else its name. */
function clientProfileLabel(profile: string | null): string {
  return profile === null ? 'Default' : profile;
}

/** Where a client connects: the host's name when known, else its address. */
function clientServerLabel(entry: ClientProfile): string {
  return entry.hostName ?? entry.serverUrl ?? 'Not connected yet';
}

/**
 * The Maestro clients on this computer: each runs as its own window connected to another
 * computer's Maestro. Local mode only; the sidebar hides the entry in a client window.
 */
export function ClientsPage() {
  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="relative min-h-0 w-full min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col px-8 pb-12">
          <PageLayout.Header
            sticky
            draggable
            title="Clients"
            description="Use Maestro on another computer from this one. Each client opens in its own window."
          />
          {isClientMode() ? (
            <p className="text-sm text-foreground-muted">
              Clients are managed from the Maestro app on this computer.
            </p>
          ) : (
            <ClientsList />
          )}
        </div>
      </div>
    </div>
  );
}

function ClientsList() {
  const profiles = useQuery({
    queryKey: PROFILES_QUERY_KEY,
    queryFn: async () => (await getClientProfilesClient()).list(),
  });
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const open = async (entry: ClientProfile) => {
    const key = entry.profile ?? '';
    setOpeningKey(key);
    try {
      const result = await (await getClientProfilesClient()).open({ profile: entry.profile });
      if (!result.success) {
        toast.error('Could not open the client', { description: result.error.message });
        void profiles.refetch();
      }
    } catch (error) {
      toast.error('Could not open the client', { description: errorMessage(error) });
    } finally {
      setOpeningKey(null);
    }
  };

  if (profiles.data === undefined) {
    return profiles.isError ? (
      <EmptyState
        bare
        tone="error"
        label="Could not load the clients"
        action={
          <Button variant="text" onClick={() => void profiles.refetch()}>
            Try again
          </Button>
        }
      />
    ) : (
      <EmptyState bare tone="loading" label="Loading clients…" className="py-2" />
    );
  }

  const empty = profiles.data.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {empty ? (
        <p className="text-sm text-foreground-muted">No clients yet. Add one to get started.</p>
      ) : (
        <ul className="flex flex-col gap-0.5 rounded-lg border border-border-subtle bg-surface-emphasis p-1">
          {profiles.data.map((entry) => {
            const key = entry.profile ?? '';
            return (
              <li key={key}>
                <ClientRow
                  entry={entry}
                  opening={openingKey === key}
                  onOpen={() => void open(entry)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <AddClient defaultOpen={empty} onChanged={() => void profiles.refetch()} />
    </div>
  );
}

/** One client: the whole row opens it; the trailing "Open" spells out what a click does. */
function ClientRow({
  entry,
  opening,
  onOpen,
}: {
  entry: ClientProfile;
  opening: boolean;
  onOpen: () => void;
}) {
  const label = clientProfileLabel(entry.profile);
  const connected = entry.hostName !== null || entry.serverUrl !== null;
  return (
    <button
      type="button"
      className="group flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
      disabled={opening}
      aria-label={`Open ${label} client`}
      onClick={onOpen}
    >
      <span className="flex size-8 shrink-0 items-center justify-center text-foreground-passive transition-colors group-hover:text-foreground-muted">
        <MonitorIcon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{label}</span>
        <span
          className={cn(
            'truncate text-xs',
            connected ? 'text-foreground-muted' : 'text-foreground-passive'
          )}
        >
          {clientServerLabel(entry)}
        </span>
      </span>
      <span
        aria-hidden
        className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-foreground-muted transition-colors group-hover:text-foreground"
      >
        {opening ? (
          <>
            <Spinner size="sm" />
            Opening
          </>
        ) : (
          <>
            Open
            <ArrowUpRight className="size-3.5" />
          </>
        )}
      </span>
    </button>
  );
}

/** A quiet "Add client" action that reveals the name field; shown open when there are none. */
function AddClient({ defaultOpen, onChanged }: { defaultOpen: boolean; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded && !defaultOpen) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          <Plus className="size-3.5" aria-hidden />
          Add client
        </Button>
      </div>
    );
  }

  return (
    <AddClientForm
      autoFocus={expanded}
      onCancel={defaultOpen ? undefined : () => setExpanded(false)}
      onChanged={onChanged}
      onAdded={() => setExpanded(false)}
    />
  );
}

function AddClientForm({
  autoFocus,
  onCancel,
  onChanged,
  onAdded,
}: {
  autoFocus: boolean;
  onCancel: (() => void) | undefined;
  /** The list may have changed: refetch it. */
  onChanged: () => void;
  /** A client was added. */
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0) return;
    setAdding(true);
    setError(null);
    try {
      const result = await (await getClientProfilesClient()).add({ name: name.trim() });
      if (result.success) {
        setName('');
        onChanged();
        onAdded();
        toast.success(`Opening ${clientProfileLabel(result.data.profile)}`, {
          description: 'Enter the server address and pairing code in its window.',
        });
      } else {
        setError(result.error.message);
        if (result.error.type === 'exists') onChanged();
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void add(event)}>
      <Field.Root invalid={error !== null}>
        <Field.Label htmlFor={NAME_INPUT_ID}>Add a client</Field.Label>
        <Field.Description id={NAME_HINT_ID}>
          A short name such as work-vm: letters, digits and dashes.
        </Field.Description>
        <div className="flex items-center gap-2">
          <Input
            id={NAME_INPUT_ID}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            // Focus only when the person asked for the field, never on page load.
            autoFocus={autoFocus}
            maxLength={32}
            className="min-w-0 flex-1"
            placeholder="work-vm"
            value={name}
            disabled={adding}
            aria-invalid={error !== null}
            aria-describedby={error ? `${NAME_HINT_ID} ${NAME_ERROR_ID}` : NAME_HINT_ID}
            onChange={(event) => {
              setError(null);
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && onCancel) onCancel();
            }}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={adding || name.trim().length === 0}
          >
            Add
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
        {error ? (
          <p id={NAME_ERROR_ID} role="alert" className="text-xs text-foreground-error">
            {error}
          </p>
        ) : null}
      </Field.Root>
    </form>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
