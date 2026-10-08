import { ChevronDown } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { mostRecentProjectId } from '../lib/agent-groups';
import { useApp, useRouter } from './app-context';
import { Button, Spinner } from './controls';
import { Sheet } from './Sheet';

const PROMPT_MAX = 100_000;

/** Starts a new agent on the host: pick a project and an agent, say what to do. */
export const NewAgentSheet = observer(function NewAgentSheet() {
  const app = useApp();
  const router = useRouter();
  const formId = useId();
  const promptId = useId();
  const overview = app.overview;
  const projects = overview?.projects ?? [];
  const providers = overview?.providers ?? [];

  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaults are derived until the user chooses, so they are right even if the overview
  // arrives after the sheet opens (a deep link to /new).
  const projectId =
    projectChoice ??
    (app.projectFilter && projects.some((project) => project.id === app.projectFilter)
      ? app.projectFilter
      : mostRecentProjectId(
          app.agents,
          projects.map((project) => project.id)
        ));
  const providerId =
    providerChoice ??
    (overview?.defaultProviderId &&
    providers.some((provider) => provider.id === overview.defaultProviderId)
      ? overview.defaultProviderId
      : (providers[0]?.id ?? null));

  const close = (): void => router.back();
  const canStart = Boolean(app.api && projectId && prompt.trim()) && !busy;

  const start = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const api = app.api;
    if (!api || !projectId || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.remote.startAgent({
        projectId,
        prompt: prompt.trim(),
        providerId: providerId ?? undefined,
      });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      // Replace the sheet's history entry: going back from the new agent lands on the list.
      router.replace({ name: 'agent', conversationId: result.data.conversationId });
    } catch {
      setError(`Couldn’t reach ${app.hostName}. Check the connection and try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New agent"
      description={`Runs on ${app.hostName}.`}
      onClose={close}
      footer={
        <Button
          type="submit"
          form={formId}
          variant="primary"
          block
          busy={busy}
          disabled={!canStart}
        >
          {busy ? 'Starting…' : 'Start agent'}
        </Button>
      }
    >
      {!overview ? (
        <div className="text-fg-passive flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : projects.length === 0 ? (
        <p className="text-fg-muted py-8 text-center text-[14.5px]">
          There are no projects on {app.hostName} yet. Add one in Maestro on your computer first.
        </p>
      ) : (
        <form id={formId} onSubmit={(event) => void start(event)} className="flex flex-col gap-4">
          <div>
            <label htmlFor={promptId} className="text-fg-muted text-[13px] font-medium">
              What should it do?
            </label>
            <textarea
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, PROMPT_MAX))}
              rows={5}
              autoFocus
              placeholder="Describe the task…"
              autoCapitalize="sentences"
              className="border-line-strong bg-canvas text-fg placeholder:text-fg-passive focus:border-focus focus:ring-focus/25 mt-1.5 block w-full resize-none rounded-xl border px-3.5 py-3 leading-[22px] outline-none focus:ring-2"
            />
          </div>

          <Picker
            label="Project"
            value={projectId ?? ''}
            onChange={setProjectChoice}
            options={projects.map((project) => ({
              value: project.id,
              label: project.local ? project.name : `${project.name} (remote)`,
            }))}
          />
          {providers.length > 0 ? (
            <Picker
              label="Agent"
              value={providerId ?? ''}
              onChange={setProviderChoice}
              options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
            />
          ) : null}

          {error ? (
            <p
              role="alert"
              className="bg-danger-soft text-danger rounded-xl px-3.5 py-2.5 text-[14px]"
            >
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Sheet>
  );
});

type PickerProps = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  hint?: ReactNode;
};

/** A native select, styled: on a phone nothing beats the system picker wheel. */
function Picker({ label, value, options, onChange, hint }: PickerProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-fg-muted text-[13px] font-medium">
        {label}
      </label>
      <div className="relative mt-1.5">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="border-line-strong bg-canvas text-fg focus:border-focus focus:ring-focus/25 h-12 w-full appearance-none truncate rounded-xl border pr-10 pl-3.5 outline-none focus:ring-2"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="text-fg-passive pointer-events-none absolute top-1/2 right-3.5 size-[18px] -translate-y-1/2"
          aria-hidden="true"
        />
      </div>
      {hint}
    </div>
  );
}
