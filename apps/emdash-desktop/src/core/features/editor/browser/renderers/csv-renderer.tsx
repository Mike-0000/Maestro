import { EmptyState } from '@emdash/ui/react/components';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS, parseCsv } from './csv-parser';

interface CsvRendererProps {
  tab: FileTabResource;
}

/**
 * Renders a CSV file as a table preview.
 * The source/preview toggle lives in the FileContent container above this component.
 * Load-time states are handled above this component by FileStatusPlaceholder.
 */
export const CsvRenderer = observer(function CsvRenderer({ tab }: CsvRendererProps) {
  // Touch bufferVersion so this observer re-renders when the buffer is first
  // populated or updated externally before reading the non-observable text.
  void tab.bufferVersion;
  const content = tab.bufferText();
  const parsed = useMemo(() => parseCsv(content), [content]);
  const [header, ...bodyRows] = parsed.rows;
  const columnCount = Math.max(
    1,
    ...(parsed.rows.length ? parsed.rows.map((row) => row.length) : [1])
  );

  // A dense table on the editor's paper: a sticky muted header, hairline row rules
  // (dense tables are the one place rules are allowed), no column rules or zebra fills.
  return (
    <div className="h-full w-full overflow-hidden">
      {parsed.rows.length ? (
        <div className="h-full overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 cursor-text text-left text-xs tabular-nums">
            <thead>
              <tr>
                {normalizeRow(header ?? [], columnCount).map((cell, index) => (
                  <th
                    key={index}
                    className="sticky top-0 z-[1] h-8 max-w-80 border-b border-border-subtle bg-(--em-surface) px-3 font-medium text-foreground-muted"
                  >
                    <span className="block truncate">{cell || `Column ${index + 1}`}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-surface-hover">
                  {normalizeRow(row, columnCount).map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="max-w-80 border-b border-border-subtle px-3 py-1.5 align-top whitespace-pre-wrap text-foreground"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {parsed.truncatedRows > 0 || parsed.truncatedColumns > 0 ? (
            <div className="sticky bottom-0 bg-(--em-surface) px-3 py-2 text-tiny text-foreground-passive">
              Preview capped at{' '}
              {parsed.truncatedRows > 0 ? `${MAX_PREVIEW_ROWS.toLocaleString()} rows` : null}
              {parsed.truncatedRows > 0 && parsed.truncatedColumns > 0 ? ' and ' : null}
              {parsed.truncatedColumns > 0
                ? `${MAX_PREVIEW_COLUMNS.toLocaleString()} columns`
                : null}
              .
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState bare label="Empty file" description="This file has no rows yet." />
      )}
    </div>
  );
});

function normalizeRow(row: string[], columnCount: number): string[] {
  if (row.length >= columnCount) return row;
  return [...row, ...Array.from({ length: columnCount - row.length }, () => '')];
}
