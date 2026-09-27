import { existsSync } from 'node:fs';
import { SQLiteAdapter } from '@invoker/data-store';
import { getChokeBoundaryMetrics } from './choke-boundary-metrics.js';

export interface MainProcessDatabaseOptions {
  dbPath: string;
  detachedViewer: boolean;
  readOnly: boolean;
  exclusiveLocking: boolean;
}

export async function openMainProcessDatabase(options: MainProcessDatabaseOptions): Promise<SQLiteAdapter> {
  const chokeMetrics = getChokeBoundaryMetrics();
  if (options.detachedViewer) {
    if (!existsSync(options.dbPath)) {
      return openDetachedViewerDatabase();
    }

    return SQLiteAdapter.create(options.dbPath, {
      readOnly: true,
      ownerCapability: false,
      exclusiveLocking: false,
      onTransactionDuration: (info) => chokeMetrics.recordSqliteTransaction(info),
      onBusyFailure: (info) => chokeMetrics.recordSqliteBusyFailure(info),
    });
  }

  // Read-only headless snapshots should report an empty store before the first
  // owner creates invoker.db; opening SQLite read-only cannot create that file.
  if (options.readOnly && !existsSync(options.dbPath)) {
    return openDetachedViewerDatabase();
  }

  return SQLiteAdapter.create(options.dbPath, {
    readOnly: options.readOnly,
    ownerCapability: !options.readOnly,
    exclusiveLocking: !options.readOnly && options.exclusiveLocking,
    onTransactionDuration: (info) => chokeMetrics.recordSqliteTransaction(info),
    onBusyFailure: (info) => chokeMetrics.recordSqliteBusyFailure(info),
  });
}

export async function openDetachedViewerDatabase(): Promise<SQLiteAdapter> {
  const chokeMetrics = getChokeBoundaryMetrics();
  return SQLiteAdapter.createEphemeral({
    onTransactionDuration: (info) => chokeMetrics.recordSqliteTransaction(info),
    onBusyFailure: (info) => chokeMetrics.recordSqliteBusyFailure(info),
  });
}
