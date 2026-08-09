/**
 * Executable guardrails for the CLI onboarding wizard, encoding lessons from
 * past regressions as assertions instead of tribal knowledge — so a future
 * AI-assisted rewrite of onboarding.ts can't silently reintroduce them. Each
 * function throws on violation; wire calls into onboarding.test.ts alongside
 * the flow it guards, following the pattern in
 * packages/workflow-core/src/state-invariants.ts.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Guards the Drafter-MCP regression: an optional external tool must never be
 * installed/written without a prior prompt that names it and calls it optional.
 * Scans `printedLines` in order; if nothing about `toolName` looks like an
 * install, there is nothing to guard (pass trivially).
 */
export function assertOptionalToolPromptedBeforeInstall(printedLines: readonly string[], toolName: string): void {
  const nameRe = new RegExp(escapeRegExp(toolName), 'i');
  const installIndex = printedLines.findIndex((line) => nameRe.test(line) && /\b(install(ed)?|wrote|enabled)\b/i.test(line));
  if (installIndex === -1) return;

  const promptedBefore = printedLines
    .slice(0, installIndex)
    .some((line) => nameRe.test(line) && /\boptional\b/i.test(line));
  if (!promptedBefore) {
    throw new Error(`"${toolName}" was installed/written without an earlier prompt naming it as optional`);
  }
}

const GUARDED_CONFIG_FILENAMES = ['config.json', 'mcp.json', '.env'];

/**
 * Guards against a "declined everything" wizard run writing anything.
 * `writtenFilePaths` should be every file path the wizard actually wrote
 * during the run (e.g. from existsSync checks or a write log).
 */
export function assertNoConfigWriteOnAllDeclined(writtenFilePaths: readonly string[], allDeclined: boolean): void {
  if (!allDeclined) return;
  const offending = writtenFilePaths.filter((path) => GUARDED_CONFIG_FILENAMES.some((name) => path.endsWith(name)));
  if (offending.length > 0) {
    throw new Error(`declining every setup prompt must not write any file, but wrote: ${offending.join(', ')}`);
  }
}

/**
 * Guards the remote-doctor gate added alongside this module: a machine must
 * never be persisted to config while any required readiness check failed.
 */
export function assertRemoteTargetOnlyPersistedAfterAllChecksPass(
  doctorChecks: readonly { id?: string; status: string }[],
  written: boolean,
): void {
  const failed = doctorChecks.filter((check) => check.status === 'error');
  if (written && failed.length > 0) {
    throw new Error(`remote target was persisted to config despite failing checks: ${failed.map((check) => check.id ?? '?').join(', ')}`);
  }
}

/**
 * Guards against a secret (SSH key path contents, token, password) ending up
 * in printed wizard output. Ignores trivially short values (<6 chars) so
 * empty/placeholder fields don't produce false positives.
 */
export function assertNoSecretPrinted(printedLines: readonly string[], secretValues: readonly string[]): void {
  for (const secret of secretValues) {
    if (secret.trim().length < 6) continue;
    const leaked = printedLines.find((line) => line.includes(secret));
    if (leaked) {
      throw new Error(`a secret value was printed to stdout: "${leaked.slice(0, 40)}${leaked.length > 40 ? '…' : ''}"`);
    }
  }
}

/**
 * Guards the disk-headroom-cleanup regression: a worker toggle's configPath
 * must look like a real dotted InvokerConfig field, never a bare env var
 * name. This is what would have caught `INVOKER_DISK_CLEANUP_ENABLED` being
 * used as a toggle's source of truth instead of a config field.
 */
export function assertWorkerToggleHasSingleConfigSource(spec: { id: string; configPath: string }): void {
  if (/^[A-Z][A-Z0-9_]*$/.test(spec.configPath)) {
    throw new Error(`worker toggle "${spec.id}" is backed by what looks like a bare env var name ("${spec.configPath}") instead of an InvokerConfig field`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)?$/.test(spec.configPath)) {
    throw new Error(`worker toggle "${spec.id}" has a malformed configPath "${spec.configPath}"`);
  }
}
