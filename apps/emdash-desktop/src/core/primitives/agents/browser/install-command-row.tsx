import { Check, Copy } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import type { InstallMethod } from '@core/primitives/agents/api';
import { cn } from '@core/primitives/styling/browser/cn';

export function humanizeMethod(method: InstallMethod): string {
  const labels: Record<InstallMethod, string> = {
    'installer-macos': 'macOS Installer',
    'installer-windows': 'Windows Installer',
    'installer-linux': 'Linux Installer',
    homebrew: 'Homebrew',
    winget: 'winget',
    powershell: 'PowerShell',
    npm: 'npm',
    apt: 'apt',
    curl: 'curl',
    pip: 'pip',
    cargo: 'cargo',
    other: 'Other',
  };
  return labels[method] ?? method;
}

/** Copies the command; quiet until the command well is hovered or the button is focused. */
export function CopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-sm text-foreground-passive transition-[color,background-color,opacity] outline-none hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring',
        copied ? 'opacity-100' : 'opacity-0 group-hover/command:opacity-100'
      )}
      aria-label={copied ? 'Command copied' : 'Copy command'}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * A shell command in a quiet well (the emphasis surface, mono caption type) with copy on hover,
 * and an optional action (Install, Update, Retry) at its right end.
 */
export function CommandRow({ command, action }: { command: string; action: React.ReactNode }) {
  return (
    <div className="group/command flex min-h-8 w-full min-w-0 items-center gap-1 rounded-md bg-surface-emphasis py-1 pr-1 pl-2.5">
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs text-foreground-muted"
        title={command}
      >
        {command}
      </code>
      <CopyButton command={command} />
      {action}
    </div>
  );
}

/** The action inside a `CommandRow`: a small quiet button in full-strength text. */
export function CommandActionButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-foreground transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-foreground-passive disabled:hover:bg-transparent',
        className
      )}
      {...props}
    />
  );
}
