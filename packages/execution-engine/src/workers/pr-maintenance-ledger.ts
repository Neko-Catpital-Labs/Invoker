import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable append-only attempt ledger (TSV: `kind \t key \t marker \t epoch`),
 * ported from the shell `ledger_*` helpers. Markers are opaque strings: the
 * coderabbit job records a comment's ISO-8601 `updated_at`, the conflict-rebase
 * job records a workflow generation.
 */
export interface PrMaintenanceLedger {
  /** Append one attempt row. */
  record(kind: string, key: string, marker: string): void;
  /**
   * Rows matching `kind`+`key`, further scoped to `marker` when given. The
   * marker scope keeps an attempt cap per feedback-batch instead of
   * per-key-lifetime.
   */
  count(kind: string, key: string, marker?: string): number;
  /** True when this exact `kind`+`key`+`marker` row was recorded before. */
  markerSeen(kind: string, key: string, marker: string): boolean;
  /** The lexically greatest marker recorded for `kind`+`key` (`''` when none). */
  maxMarker(kind: string, key: string): string;
}

/** Tuning for {@link openPrMaintenanceLedger}. */
export interface PrMaintenanceLedgerOptions {
  /** Clock seam (ms epoch) for the recorded timestamp column. Defaults to `Date.now`. */
  now?: () => number;
}

interface LedgerRow {
  kind: string;
  key: string;
  marker: string;
}

/**
 * Open (creating if needed) the ledger at `path` and return its accessor. Reads
 * re-scan the file each call — the files are tiny (one line per attempt).
 */
export function openPrMaintenanceLedger(
  path: string,
  options: PrMaintenanceLedgerOptions = {},
): PrMaintenanceLedger {
  const now = options.now ?? Date.now;
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '');

  const readRows = (): LedgerRow[] => {
    const raw = readFileSync(path, 'utf8');
    const rows: LedgerRow[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const fields = line.split('\t');
      if (fields.length < 3) continue;
      rows.push({ kind: fields[0], key: fields[1], marker: fields[2] });
    }
    return rows;
  };

  return {
    record(kind, key, marker): void {
      const epochSeconds = Math.floor(now() / 1000);
      appendFileSync(path, `${kind}\t${key}\t${marker}\t${epochSeconds}\n`);
    },
    count(kind, key, marker): number {
      let total = 0;
      for (const row of readRows()) {
        if (row.kind !== kind || row.key !== key) continue;
        if (marker !== undefined && row.marker !== marker) continue;
        total += 1;
      }
      return total;
    },
    markerSeen(kind, key, marker): boolean {
      return readRows().some((row) => row.kind === kind && row.key === key && row.marker === marker);
    },
    maxMarker(kind, key): string {
      let max = '';
      for (const row of readRows()) {
        if (row.kind !== kind || row.key !== key) continue;
        // Lexical comparison: ISO-8601 timestamps sort lexically == chronologically.
        if (max === '' || row.marker > max) max = row.marker;
      }
      return max;
    },
  };
}
