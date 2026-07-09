import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable, append-only attempt ledger for the PR-maintenance workers.
 *
 * This is the native port of the `ledger_*` helpers in `scripts/cron-pr-lib.sh`.
 * Each line is a tab-separated `kind \t key \t marker \t epochSeconds` record.
 * One file per job (both under `~/.invoker` by default). Markers are opaque
 * strings: the CodeRabbit job records a comment's ISO-8601 `updated_at`; the
 * conflict job records a workflow generation. ISO-8601 timestamps sort lexically
 * == chronologically, so the string comparisons below match the shell awk logic.
 */
export interface PrMaintenanceLedger {
  /** Append `kind \t key \t marker \t now`. Mirrors `ledger_record`. */
  record(kind: string, key: string, marker: string): void;
  /**
   * Count rows matching `kind` + `key` — and `marker` too when provided.
   * Mirrors `ledger_count`: passing `marker` scopes the cap to one feedback
   * batch (comment timestamp / workflow generation).
   */
  count(kind: string, key: string, marker?: string): number;
  /** True when that exact `marker` was recorded. Mirrors `ledger_marker_seen`. */
  markerSeen(kind: string, key: string, marker: string): boolean;
  /** The lexical max marker recorded (undefined when none). Mirrors `ledger_max_marker`. */
  maxMarker(kind: string, key: string): string | undefined;
}

export interface PrMaintenanceLedgerOptions {
  /** Clock seam (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
}

interface LedgerRow {
  kind: string;
  key: string;
  marker: string;
}

/**
 * Open (creating parents and the file if needed) the ledger at `path`. Mirrors
 * `ledger_init` followed by the `ledger_*` readers/writers.
 */
export function openPrMaintenanceLedger(
  path: string,
  options: PrMaintenanceLedgerOptions = {},
): PrMaintenanceLedger {
  const now = options.now ?? Date.now;
  mkdirSync(dirname(path), { recursive: true });
  // `touch`: ensure the file exists so reads never throw on a first run.
  writeFileSync(path, '', { flag: 'a' });

  const readRows = (): LedgerRow[] => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const rows: LedgerRow[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      const [kind, key, marker] = line.split('\t');
      if (kind === undefined || key === undefined) continue;
      rows.push({ kind, key, marker: marker ?? '' });
    }
    return rows;
  };

  return {
    record(kind, key, marker) {
      const epochSeconds = Math.floor(now() / 1000);
      appendFileSync(path, `${kind}\t${key}\t${marker}\t${epochSeconds}\n`);
    },
    count(kind, key, marker) {
      let count = 0;
      for (const row of readRows()) {
        if (row.kind !== kind || row.key !== key) continue;
        if (marker !== undefined && row.marker !== marker) continue;
        count += 1;
      }
      return count;
    },
    markerSeen(kind, key, marker) {
      return readRows().some((row) => row.kind === kind && row.key === key && row.marker === marker);
    },
    maxMarker(kind, key) {
      let max: string | undefined;
      for (const row of readRows()) {
        if (row.kind !== kind || row.key !== key) continue;
        if (max === undefined || row.marker > max) max = row.marker;
      }
      return max;
    },
  };
}
