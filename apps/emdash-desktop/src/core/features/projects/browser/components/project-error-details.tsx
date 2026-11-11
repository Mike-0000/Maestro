import { redactAll } from '@emdash/shared/logger';
import { Button, Popover } from '@emdash/ui/react/primitives';

export function ProjectErrorDetails({ message }: { message?: string }) {
  const detail = message?.trim();
  if (!detail) return null;
  const redacted = redactAll(detail);

  return (
    <Popover.Root key={redacted}>
      <Popover.Trigger render={<Button type="button" variant="text" className="shrink-0" />}>
        Error details
      </Popover.Trigger>
      <Popover.Content className="w-96 max-w-[calc(100vw-2rem)]">
        <Popover.Header>
          <Popover.Title>Error details</Popover.Title>
        </Popover.Header>
        <pre className="max-h-64 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-foreground-muted select-text">
          {redacted}
        </pre>
      </Popover.Content>
    </Popover.Root>
  );
}
