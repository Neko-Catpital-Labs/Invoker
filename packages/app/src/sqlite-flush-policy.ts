export const OWNER_SQLITE_FLUSH_DEBOUNCE_MS = '250';

export function ensureSqliteFlushDebounceForOwner(
  env: NodeJS.ProcessEnv,
  readOnly: boolean,
): void {
  if (readOnly) return;
  if (env.INVOKER_SQLITE_FLUSH_DEBOUNCE_MS !== undefined) return;
  env.INVOKER_SQLITE_FLUSH_DEBOUNCE_MS = OWNER_SQLITE_FLUSH_DEBOUNCE_MS;
}
