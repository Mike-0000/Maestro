import { Button, Dialog, Tooltip } from '@emdash/ui/react/primitives';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

export type ExternalLinkChoice = 'emdash-browser' | 'external-browser';

export type ExternalLinkChoiceDialogArgs = {
  url: string;
  canOpenInEmdashBrowser: boolean;
  onCopy: () => boolean | Promise<boolean>;
};

/**
 * Asked before a link leaves the app: the address in a quiet code well (with a copy glyph),
 * then where to open it. The system browser is the one move; Maestro's own browser is the quiet
 * alternative beside it.
 */
export function ExternalLinkChoiceDialog({
  url,
  canOpenInEmdashBrowser,
  onCopy,
}: ExternalLinkChoiceDialogArgs) {
  const controller = useModalController('confirmExternalLinkModal');
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    },
    []
  );

  const handleCopy = async () => {
    if (!(await onCopy())) return;
    setCopied(true);
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => {
      setCopied(false);
      copyResetRef.current = null;
    }, 1_500);
  };

  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>Open this link?</Dialog.Title>
        <Dialog.Description>Choose where to open it.</Dialog.Description>
      </Dialog.Header>
      <Dialog.Body>
        <div className="relative rounded-md bg-surface-emphasis">
          <div className="max-h-32 overflow-y-auto py-2.5 pr-11 pl-3 font-mono text-xs break-all text-foreground select-text">
            {url}
          </div>
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon
                  className="absolute top-1 right-1"
                  aria-label={copied ? 'Link copied' : 'Copy link'}
                  onClick={() => void handleCopy()}
                />
              }
            >
              {copied ? <Check className="size-4 text-foreground" /> : <Copy className="size-4" />}
            </Tooltip.Trigger>
            <Tooltip.Content>{copied ? 'Copied' : 'Copy link'}</Tooltip.Content>
          </Tooltip.Root>
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" className="sm:mr-auto sm:-ml-3" onClick={controller.dismiss}>
          Cancel
        </Button>
        <Button
          variant="ghost"
          disabled={!canOpenInEmdashBrowser}
          onClick={() => controller.complete('emdash-browser')}
        >
          Open in Maestro
        </Button>
        <Button variant="primary" onClick={() => controller.complete('external-browser')}>
          Open in browser
        </Button>
      </Dialog.Footer>
    </>
  );
}

export const confirmExternalLinkModal = defineModal<ExternalLinkChoice>()({
  id: 'confirmExternalLinkModal',
  component: ExternalLinkChoiceDialog,
  size: 'md',
});
