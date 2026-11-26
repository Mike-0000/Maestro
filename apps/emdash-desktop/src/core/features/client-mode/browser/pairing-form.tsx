import { Button, Collapsible, Field, Input, Spinner } from '@emdash/ui/react/primitives';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { copyTextToClipboard } from '@core/primitives/desktop-host/browser/host-client';
import {
  errorMessage,
  headlessPairingCommand,
  pairErrorHint,
  SETTINGS_PATH,
  validatePairFields,
  type PairFields,
} from './client-session-format';
import type { ClientSession } from './client-session-store';
import { InlineError } from './state-panel';

type Outcome =
  | { status: 'idle' }
  | { status: 'pairing' }
  | { status: 'paired' }
  | { status: 'failed'; message: string; hint: string | null };

/**
 * The host's address and a one-time full-access code. Left-aligned fields in one narrow column;
 * the Cloudflare Access fields and the headless-host command stay folded until asked for.
 */
export function PairingForm({
  session,
  initialUrl = '',
  submitLabel = 'Connect',
  autoFocus = true,
}: {
  session: ClientSession;
  initialUrl?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const [fields, setFields] = useState<PairFields>({
    url: initialUrl,
    code: '',
    cfAccessClientId: '',
    cfAccessClientSecret: '',
  });
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' });
  const [showCloudflare, setShowCloudflare] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = outcome.status === 'pairing' || outcome.status === 'paired';
  const settle = (next: Outcome) => {
    if (mounted.current) setOutcome(next);
  };

  const change = (key: keyof PairFields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    // An answer about one address or code says nothing about an edited one.
    setOutcome((current) => (current.status === 'failed' ? { status: 'idle' } : current));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const invalid = validatePairFields(fields);
    if (invalid) return setOutcome({ status: 'failed', message: invalid, hint: null });
    setOutcome({ status: 'pairing' });
    try {
      const result = await session.pair({
        url: fields.url.trim(),
        code: fields.code.trim(),
        cfAccessClientId: fields.cfAccessClientId.trim() || undefined,
        cfAccessClientSecret: fields.cfAccessClientSecret.trim() || undefined,
      });
      settle(
        result.success
          ? { status: 'paired' }
          : {
              status: 'failed',
              message: result.error.message,
              hint: pairErrorHint(result.error.type),
            }
      );
    } catch (error) {
      settle({ status: 'failed', message: errorMessage(error), hint: null });
    }
  };

  return (
    <form
      noValidate
      className="mx-auto flex w-full max-w-sm flex-col text-left"
      onSubmit={(event) => void submit(event)}
    >
      <fieldset disabled={busy} className="m-0 grid min-w-0 gap-5 border-0 p-0">
        <Field.Root>
          <Field.Label>Host address</Field.Label>
          <Input
            value={fields.url}
            placeholder="https://my-vm.tailnet.ts.net"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus={autoFocus && !initialUrl}
            onChange={(event) => change('url')(event.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Pairing code</Field.Label>
          <Input
            value={fields.code}
            className="font-mono"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus={autoFocus && !!initialUrl}
            onChange={(event) => change('code')(event.target.value)}
          />
          <Field.Description>
            Create a full-access code on the host under {SETTINGS_PATH}. Each code works once.
          </Field.Description>
        </Field.Root>
        <Collapsible.Root open={showCloudflare} onOpenChange={setShowCloudflare}>
          <div className="w-fit">
            <Collapsible.Trigger type="button" variant="text">
              Cloudflare Access
            </Collapsible.Trigger>
          </div>
          <Collapsible.Panel className="grid gap-5 pt-3">
            <p className="text-sm text-foreground-muted">
              Only needed when the host is published through Cloudflare Access. Enter the service
              token created for this computer.
            </p>
            <Field.Root>
              <Field.Label>Client ID</Field.Label>
              <Input
                value={fields.cfAccessClientId}
                placeholder="xxxxxxxx.access"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => change('cfAccessClientId')(event.target.value)}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>Client secret</Field.Label>
              <Input
                type="password"
                value={fields.cfAccessClientSecret}
                autoComplete="off"
                onChange={(event) => change('cfAccessClientSecret')(event.target.value)}
              />
            </Field.Root>
          </Collapsible.Panel>
        </Collapsible.Root>
      </fieldset>

      {outcome.status === 'failed' && (
        <div className="mt-5 flex flex-col gap-1.5">
          <InlineError>{outcome.message}</InlineError>
          {outcome.hint ? (
            <p className="pl-3.5 text-xs text-foreground-muted">{outcome.hint}</p>
          ) : null}
        </div>
      )}

      <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy}>
        {outcome.status === 'pairing' ? (
          <>
            <Spinner size="sm" />
            Pairing…
          </>
        ) : outcome.status === 'paired' ? (
          <>
            <Spinner size="sm" />
            Paired. Connecting…
          </>
        ) : (
          submitLabel
        )}
      </Button>

      <HeadlessHostHelp />
    </form>
  );
}

/** How to get a code from a host nobody can sit at: one command, run on the host. */
function HeadlessHostHelp() {
  const command = headlessPairingCommand();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await copyTextToClipboard(command);
      setCopied(true);
    } catch {
      // The command stays selectable in place, so a failed copy needs no message.
    }
  };

  return (
    <Collapsible.Root className="mt-5">
      <div className="w-fit">
        <Collapsible.Trigger type="button" variant="text">
          The host has no screen?
        </Collapsible.Trigger>
      </div>
      <Collapsible.Panel className="flex flex-col gap-2 pt-3">
        <p className="text-sm text-foreground-muted">
          With full access turned on, run this on the host over SSH. It prints a code.
        </p>
        <code className="block rounded-md bg-surface-emphasis px-3 py-2 font-mono text-xs break-all text-foreground-body select-all">
          {command}
        </code>
        <div>
          <Button type="button" variant="text" size="xs" onClick={() => void copy()}>
            <span aria-live="polite">{copied ? 'Copied' : 'Copy command'}</span>
          </Button>
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
