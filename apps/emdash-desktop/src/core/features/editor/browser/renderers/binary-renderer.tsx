import { EmptyState } from '@emdash/ui/react/components';

interface BinaryRendererProps {
  file: { path: string };
}

/** Shown for binary or otherwise unsupported files. */
export function BinaryRenderer({ file }: BinaryRendererProps) {
  const fileName = file.path.split('/').pop() ?? file.path;
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : undefined;

  return (
    <EmptyState
      bare
      label="Binary file, no preview available"
      description={ext ? `${fileName} · ${ext} file` : fileName}
    />
  );
}
