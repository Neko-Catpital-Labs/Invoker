import { existsSync } from 'node:fs';
import { SQLiteAdapter } from '@invoker/data-store';

export interface MainProcessDatabaseOptions {
  dbPath: string;
  detachedViewer: boolean;
  readOnly: boolean;
  exclusiveLocking: boolean;
}

export async function openMainProcessDatabase(options: MainProcessDatabaseOptions): Promise<SQLiteAdapter> {
  if (options.detachedViewer) {
    return openDetachedViewerDatabase();
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
  });
}

export async function openDetachedViewerDatabase(): Promise<SQLiteAdapter> {
  return SQLiteAdapter.createEphemeral();
}
