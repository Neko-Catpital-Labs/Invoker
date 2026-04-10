import { describe, it, expect, afterEach } from 'vitest';
import { SQLiteAdapter as DataStoreSQLiteAdapter } from '../sqlite-adapter.js';
import { SQLiteAdapter as PersistenceSQLiteAdapter } from '@invoker/persistence';

describe('schema divergence', () => {
  const adapters: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const adapter of adapters) {
      adapter.close();
    }
    adapters.length = 0;
  });

  it.fails('data-store and persistence tasks tables have identical column sets', async () => {
    // C1a repro — do not delete

    const dataStoreAdapter = await DataStoreSQLiteAdapter.create(':memory:');
    adapters.push(dataStoreAdapter);

    const persistenceAdapter = await PersistenceSQLiteAdapter.create(':memory:');
    adapters.push(persistenceAdapter);

    // Use PRAGMA table_info to get column names from both databases
    const dataStoreColumns = getTableColumns(dataStoreAdapter, 'tasks');
    const persistenceColumns = getTableColumns(persistenceAdapter, 'tasks');

    // Extract just the column names for comparison
    const dataStoreColNames = new Set(dataStoreColumns.map(c => c.name));
    const persistenceColNames = new Set(persistenceColumns.map(c => c.name));

    // Compute the diff for detailed reporting
    const onlyInDataStore = Array.from(dataStoreColNames)
      .filter(col => !persistenceColNames.has(col))
      .sort();
    const onlyInPersistence = Array.from(persistenceColNames)
      .filter(col => !dataStoreColNames.has(col))
      .sort();

    // Assert the column name sets are equal with detailed diff
    expect(
      onlyInDataStore.length === 0 && onlyInPersistence.length === 0,
      `Schema divergence detected:\n` +
      `Columns only in data-store: ${JSON.stringify(onlyInDataStore)}\n` +
      `Columns only in persistence: ${JSON.stringify(onlyInPersistence)}`
    ).toBe(true);
  });
});

/**
 * Extract column information from a table using PRAGMA table_info.
 */
function getTableColumns(adapter: any, tableName: string): Array<{ name: string; type: string }> {
  // Access the private db property to run raw queries
  const db = (adapter as any).db;
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
  const columns: Array<{ name: string; type: string }> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    columns.push({
      name: row.name as string,
      type: row.type as string,
    });
  }
  stmt.free();
  return columns;
}
