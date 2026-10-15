import { afterEach, describe, expect, it } from 'vitest';
import { reclaimFreePages } from './compaction';
import { fileSearchStore } from './store';

const handles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function open() {
  const handle = fileSearchStore.open(':memory:');
  handles.push(handle);
  return handle.connection;
}

describe('file-search index compaction', () => {
  it('opens the index in incremental auto-vacuum mode', () => {
    const connection = open();
    expect(connection.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum')?.auto_vacuum).toBe(2);
  });

  it('returns free pages to the filesystem once enough have piled up', () => {
    const connection = open();
    connection.exec('CREATE TABLE filler (value TEXT)');
    connection.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO filler SELECT printf('%0200d', i) FROM n"
    );
    connection.exec('DELETE FROM filler');
    const freeBefore = connection.get<{ freelist_count: number }>('PRAGMA freelist_count');
    expect(freeBefore?.freelist_count).toBeGreaterThan(10);

    reclaimFreePages(connection, freeBefore!.freelist_count + 1);
    expect(connection.get<{ freelist_count: number }>('PRAGMA freelist_count')).toEqual(freeBefore);

    reclaimFreePages(connection, 10);
    expect(
      connection.get<{ freelist_count: number }>('PRAGMA freelist_count')?.freelist_count
    ).toBe(0);
  });
});
