import { EmptyState } from '@emdash/ui/react/components';
import { SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Field, Input, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { MonitorIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { getClientProfilesClient } from '@core/features/client-profiles/api/browser/client';
import type { ClientProfile } from '@core/features/client-profiles/api/contract';

const NAME_INPUT_ID = 'client-profiles-name';
const NAME_HINT_ID = 'client-profiles-name-hint';
const NAME_ERROR_ID = 'client-profiles-name-error';

const PROFILES_QUERY_KEY = ['clientProfiles', 'list'] as const;

/** The display name of a profile: "Default" for the unnamed one, else its name. */
export function clientProfileLabel(profile: string | null): string {
  return profile === null ? 'Default' : profile;
}

/**
 * The Maestro clients on this computer: each runs as its own window connected to another
 * computer's Maestro. Local mode only; the caller hides it in a client window.
 */
export function ClientProfilesCard() {
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

  return (
    <SettingsSection
      title="Maestro clients"
      description="Use Maestro on another computer from this one. Each client opens in its own window."
    >
      {profiles.data === undefined ? (
        profiles.isError ? (
          <p className="text-sm text-foreground-muted">Could not load the clients.</p>
        ) : (
          <EmptyState bare tone="loading" label="Loading clients…" className="py-2" />
        )
      ) : profiles.data.length === 0 ? (
        <p className="text-sm text-foreground-muted">No clients yet. Add one below.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {profiles.data.map((entry) => {
            const label = clientProfileLabel(entry.profile);
            return (
              <li key={entry.profile ?? ''} className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center text-foreground-passive">
                  <MonitorIcon className="size-4" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">{label}</span>
                  <span className="truncate text-xs text-foreground-muted">
                    {entry.serverUrl ?? 'Not connected yet'}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  disabled={openingKey === (entry.profile ?? '')}
                  aria-label={`Open ${label} client`}
                  onClick={() => void open(entry)}
                >
                  Open
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <AddClientForm onAdded={() => void profiles.refetch()} />
    </SettingsSection>
  );
}

function AddClientForm({ onAdded }: { onAdded: () => void }) {
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
        onAdded();
        toast.success(`Opening ${clientProfileLabel(result.data.profile)}`, {
          description: 'Enter the server address and pairing code in its window.',
        });
      } else {
        setError(result.error.message);
        if (result.error.type === 'exists') onAdded();
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
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={adding || name.trim().length === 0}
          >
            Add
          </Button>
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
