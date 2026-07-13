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

  return SQLiteAdapter.create(options.dbPath, {
    readOnly: options.readOnly,
    ownerCapability: !options.readOnly,
    exclusiveLocking: !options.readOnly && options.exclusiveLocking,
  });
}

export async function openDetachedViewerDatabase(): Promise<SQLiteAdapter> {
  return SQLiteAdapter.createEphemeral();
}
