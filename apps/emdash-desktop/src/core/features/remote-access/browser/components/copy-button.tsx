import { Button, toast } from '@emdash/ui/react/primitives';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyTextToClipboard } from '@core/primitives/desktop-host/browser/host-client';
import { errorMessage } from './remote-access-row';

/** Copies `text` and confirms in place for a moment; `label` names what is copied. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // A new value has not been copied yet.
  useEffect(() => setCopied(false), [text]);

  const copy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
    } catch (error) {
      toast.error('Could not copy', { description: errorMessage(error) });
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}
