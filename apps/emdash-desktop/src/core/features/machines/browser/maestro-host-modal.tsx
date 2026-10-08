import { useAppForm } from '@emdash/ui/react/form';
import { Button, Collapsible, Dialog, ModalLayout } from '@emdash/ui/react/primitives';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import type { SshConfig } from '@core/primitives/ssh/api';
import type { MaestroHostInfo } from '../api/maestro-host';
import {
  maestroHostFormDefaults,
  maestroHostFormTitle,
  maestroHostSubmitLabel,
  validateMaestroHostForm,
  type MaestroHostFormMode,
} from './maestro-host-form-model';

/** `add` pairs with a new host; `repair` and `edit` act on an existing Maestro host machine. */
export type MaestroHostModalProps =
  | { mode?: 'add'; machine?: undefined }
  | { mode: 'repair' | 'edit'; machine: SshConfig };

type Operation =
  | { status: 'idle' }
  | { status: 'checking' | 'saving' }
  | { status: 'found'; info: MaestroHostInfo }
  | { status: 'failed'; message: string };

const MAESTRO_HOST_FORM_ID = 'maestro-host-form';

export function MaestroHostModal({ mode = 'add', machine }: MaestroHostModalProps) {
  const modal = useModalController('maestroHostModal');
  const machines = getMachinesStore();
  const form = useAppForm({ defaultValues: maestroHostFormDefaults(machine) });
  const [operation, setOperation] = useState<Operation>({ status: 'idle' });
  const [showCloudflare, setShowCloudflare] = useState(!!machine?.maestro?.cfAccessClientId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // An answer about one address or code says nothing about an edited one.
  useEffect(() => {
    const subscription = form.store.subscribe(() => {
      setOperation((current) =>
        current.status === 'found' || current.status === 'failed' ? { status: 'idle' } : current
      );
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const busy = operation.status === 'checking' || operation.status === 'saving';
  const settle = (next: Operation) => {
    if (mounted.current) setOperation(next);
  };

  const check = async () => {
    if (busy) return;
    const values = form.state.values;
    const invalid = validateMaestroHostForm(values, 'check');
    if (invalid) return setOperation({ status: 'failed', message: invalid });
    setOperation({ status: 'checking' });
    try {
      const result = await machines.inspectMaestroHost({
        url: values.url,
        cfAccessClientId: values.cfAccessClientId,
        cfAccessClientSecret: values.cfAccessClientSecret,
        machineId: machine?.id,
      });
      settle(
        result.success
          ? { status: 'found', info: result.data }
          : { status: 'failed', message: result.error.message }
      );
    } catch (error) {
      settle({ status: 'failed', message: errorMessage(error) });
    }
  };

  const submit = async () => {
    if (busy) return;
    const values = form.state.values;
    const invalid = validateMaestroHostForm(values, mode);
    if (invalid) return setOperation({ status: 'failed', message: invalid });
    setOperation({ status: 'saving' });
    try {
      const cloudflare = {
        cfAccessClientId: values.cfAccessClientId,
        cfAccessClientSecret: values.cfAccessClientSecret,
      };
      const result =
        mode === 'add' || !machine
          ? await machines.addMaestroHost({ url: values.url, code: values.code, ...cloudflare })
          : mode === 'repair'
            ? await machines.repairMaestroHost({ id: machine.id, code: values.code })
            : await machines.updateMaestroHost({ id: machine.id, url: values.url, ...cloudflare });
      if (!mounted.current) return;
      if (result.success) modal.complete({ connectionId: result.data.id });
      else setOperation({ status: 'failed', message: result.error.message });
    } catch (error) {
      settle({ status: 'failed', message: errorMessage(error) });
    }
  };

  return (
    <ModalLayout
      header={
        <Dialog.Header showCloseButton>
          <Dialog.Title>{maestroHostFormTitle(mode)}</Dialog.Title>
        </Dialog.Header>
      }
      footer={
        <Dialog.Footer>
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {mode !== 'repair' && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void check()}
                  disabled={busy}
                >
                  {operation.status === 'checking' ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      Checking…
                    </>
                  ) : (
                    'Check address'
                  )}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" onClick={modal.dismiss} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" form={MAESTRO_HOST_FORM_ID} disabled={busy}>
                {operation.status === 'saving' ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    {mode === 'edit' ? 'Saving…' : 'Pairing…'}
                  </>
                ) : (
                  maestroHostSubmitLabel(mode)
                )}
              </Button>
            </div>
          </div>
        </Dialog.Footer>
      }
    >
      <Dialog.Body className="max-h-[calc(100dvh-10rem)] overflow-y-auto">
        <form
          id={MAESTRO_HOST_FORM_ID}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy} className="m-0 grid min-w-0 gap-4 border-0 p-0">
            <p className="text-sm text-foreground-muted">{introduction(mode, machine)}</p>
            {mode !== 'repair' && (
              <form.AppField name="url">
                {(field) => (
                  <field.TextField
                    label="Host address"
                    placeholder="https://my-pc.tailnet.ts.net"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                  />
                )}
              </form.AppField>
            )}
            {mode !== 'edit' && (
              <form.AppField name="code">
                {(field) => (
                  <field.TextField
                    label="Pairing code"
                    description="Shown by Maestro on the host. Each code works once."
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={mode === 'repair'}
                  />
                )}
              </form.AppField>
            )}
            {mode !== 'repair' && (
              <Collapsible.Root open={showCloudflare} onOpenChange={setShowCloudflare}>
                <div className="w-fit">
                  <Collapsible.Trigger type="button">Cloudflare Access</Collapsible.Trigger>
                </div>
                <Collapsible.Panel className="grid gap-3 pt-2">
                  <p className="text-sm text-foreground-muted">
                    Only needed when the host is published through Cloudflare Access. Enter the
                    service token created for this device.
                  </p>
                  <form.AppField name="cfAccessClientId">
                    {(field) => (
                      <field.TextField
                        label="Client ID"
                        placeholder="xxxxxxxx.access"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="cfAccessClientSecret">
                    {(field) => (
                      <field.TextField
                        label="Client secret"
                        type="password"
                        autoComplete="off"
                        placeholder={
                          machine?.maestro?.cfAccessClientId
                            ? 'Leave blank to keep the saved secret'
                            : undefined
                        }
                      />
                    )}
                  </form.AppField>
                </Collapsible.Panel>
              </Collapsible.Root>
            )}
          </fieldset>
        </form>
        {operation.status === 'found' && (
          <p role="status" className="mt-4 flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-foreground-success" />
            Found Maestro host “{operation.info.hostName || operation.info.url}”.
          </p>
        )}
        {operation.status === 'failed' && (
          <p role="alert" className="mt-4 text-sm text-foreground-destructive">
            {operation.message}
          </p>
        )}
      </Dialog.Body>
    </ModalLayout>
  );
}

function introduction(mode: MaestroHostFormMode, machine: SshConfig | undefined): string {
  if (mode === 'repair') {
    return `Create a new pairing code in Maestro on “${machine?.name ?? 'the host'}”, then enter it here to pair this device again.`;
  }
  if (mode === 'edit') {
    return 'Change where this host is reached. The address must still lead to the same computer; its pairing is kept.';
  }
  return 'Use the Maestro app running on another computer as a machine — no SSH and nothing to install. Turn on remote access in Maestro on that computer to get its address and a pairing code.';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const maestroHostModal = defineModal<{ connectionId: string }>()({
  id: 'maestroHostModal',
  component: MaestroHostModal,
});
