import type { SlowQueryInfo } from './sqlite-adapter.js';

export interface SlowQueryAggregatorOptions {
  now?: () => number;
}

export interface SlowQueryShapeStats {
  shape: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

interface MutableShapeStats {
  shape: string;
  count: number;
  /** Bounded reservoir sample of durations, used only to estimate percentiles. */
  durationsMs: number[];
  maxMs: number;
  maxRows?: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

/** Caps per-shape duration samples so memory stays bounded for a long-lived process. */
const MAX_DURATION_SAMPLES_PER_SHAPE = 500;
/** Caps distinct tracked shapes; least-severe shape is evicted to make room for a new one. */
const MAX_TRACKED_SHAPES = 200;

/**
 * Reservoir sampling (Algorithm R): keeps a fixed-size, statistically
 * representative sample of an unbounded stream without retaining every value.
 */
function addReservoirSample(samples: number[], value: number, seenCount: number): void {
  if (samples.length < MAX_DURATION_SAMPLES_PER_SHAPE) {
    samples.push(value);
    return;
  }
  const replaceIndex = Math.floor(Math.random() * seenCount);
  if (replaceIndex < MAX_DURATION_SAMPLES_PER_SHAPE) {
    samples[replaceIndex] = value;
  }
}

const PARAMETER_PREFIXES = new Set([':', '@', '$']);
const SIGNED_NUMBER_PREFIXES = new Set([
  '(',
  '[',
  '{',
  ',',
  '=',
  '<',
  '>',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%',
  '|',
  '&',
  '~',
]);

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isHexDigit(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-fA-F]$/.test(value);
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z_]$/.test(value);
}

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9_]$/.test(value);
}

function previousNonWhitespace(sql: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = sql[i];
    if (ch !== undefined && !/\s/.test(ch)) return ch;
  }
  return undefined;
}

function canStartSignedNumber(sql: string, index: number): boolean {
  const previous = previousNonWhitespace(sql, index);
  return previous === undefined || SIGNED_NUMBER_PREFIXES.has(previous);
}

function startsNumberAt(sql: string, index: number): boolean {
  return isDigit(sql[index]) || (sql[index] === '.' && isDigit(sql[index + 1]));
}

function skipSqlStringLiteral(sql: string, quoteIndex: number): number {
  let index = quoteIndex + 1;
  while (index < sql.length) {
    if (sql[index] === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * Skips a quoted identifier (e.g. "col", `col`) so its contents are copied
 * verbatim instead of being mistaken for parameter/literal syntax. The quote
 * character escapes itself by doubling, matching SQL identifier-quoting rules.
 */
function skipDelimitedIdentifier(sql: string, quoteIndex: number, quoteChar: string): number {
  let index = quoteIndex + 1;
  while (index < sql.length) {
    if (sql[index] === quoteChar) {
      if (sql[index + 1] === quoteChar) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/** Skips a bracket-delimited identifier (e.g. [col]), MSSQL/Access style. */
function skipBracketDelimitedIdentifier(sql: string, bracketIndex: number): number {
  let index = bracketIndex + 1;
  while (index < sql.length) {
    if (sql[index] === ']') return index + 1;
    index += 1;
  }
  return sql.length;
}

function skipNumberLiteral(sql: string, startIndex: number): number {
  let index = startIndex;
  if (sql[index] === '0' && (sql[index + 1] === 'x' || sql[index + 1] === 'X')) {
    index += 2;
    while (isHexDigit(sql[index])) index += 1;
    return index;
  }

  while (isDigit(sql[index])) index += 1;
  if (sql[index] === '.' && isDigit(sql[index + 1])) {
    index += 1;
    while (isDigit(sql[index])) index += 1;
  }
  if (
    (sql[index] === 'e' || sql[index] === 'E')
    && (
      isDigit(sql[index + 1])
      || ((sql[index + 1] === '+' || sql[index + 1] === '-') && isDigit(sql[index + 2]))
    )
  ) {
    index += 1;
    if (sql[index] === '+' || sql[index] === '-') index += 1;
    while (isDigit(sql[index])) index += 1;
  }

  return index;
}

function collapseInLists(sql: string): string {
  return sql.replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi, 'IN (?)');
}

export function normalizeSlowQuerySql(sql: string): string {
  const normalized: string[] = [];

  for (let index = 0; index < sql.length;) {
    const ch = sql[index];
    const next = sql[index + 1];
    const previous = sql[index - 1];

    if ((ch === 'x' || ch === 'X') && next === "'" && !isIdentifierChar(previous)) {
      normalized.push('?');
      index = skipSqlStringLiteral(sql, index + 1);
      continue;
    }

    if (ch === "'") {
      normalized.push('?');
      index = skipSqlStringLiteral(sql, index);
      continue;
    }

    if (ch === '"' || ch === '`') {
      const end = skipDelimitedIdentifier(sql, index, ch);
      normalized.push(sql.slice(index, end));
      index = end;
      continue;
    }

    if (ch === '[') {
      const end = skipBracketDelimitedIdentifier(sql, index);
      normalized.push(sql.slice(index, end));
      index = end;
      continue;
    }

    if (ch === '?') {
      normalized.push('?');
      index += 1;
      while (isDigit(sql[index])) index += 1;
      continue;
    }

    if (ch !== undefined && PARAMETER_PREFIXES.has(ch) && isIdentifierStart(next)) {
      normalized.push('?');
      index += 2;
      while (isIdentifierChar(sql[index])) index += 1;
      continue;
    }

    if (
      (ch === '-' || ch === '+')
      && startsNumberAt(sql, index + 1)
      && canStartSignedNumber(sql, index)
    ) {
      normalized.push('?');
      index = skipNumberLiteral(sql, index + 1);
      continue;
    }

    if (startsNumberAt(sql, index) && !isIdentifierChar(previous)) {
      normalized.push('?');
      index = skipNumberLiteral(sql, index);
      continue;
    }

    if (ch !== undefined) normalized.push(ch);
    index += 1;
  }

  return collapseInLists(normalized.join('')).replace(/\s+/g, ' ').trim();
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

function snapshotStats(stats: MutableShapeStats): SlowQueryShapeStats {
  const sortedDurations = [...stats.durationsMs].sort((a, b) => a - b);
  return {
    shape: stats.shape,
    count: stats.count,
    p50Ms: percentile(sortedDurations, 50),
    p95Ms: percentile(sortedDurations, 95),
    maxMs: stats.maxMs,
    ...(stats.maxRows === undefined ? {} : { maxRows: stats.maxRows }),
    firstSeenAtMs: stats.firstSeenAtMs,
    lastSeenAtMs: stats.lastSeenAtMs,
  };
}

export class SlowQueryAggregator {
  private readonly shapes = new Map<string, MutableShapeStats>();
  private readonly now: () => number;
  private recordedCount = 0;

  constructor(options: SlowQueryAggregatorOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get totalCount(): number {
    return this.recordedCount;
  }

  get shapeCount(): number {
    return this.shapes.size;
  }

  record(info: SlowQueryInfo): void {
    const shape = normalizeSlowQuerySql(info.sql);
    const observedAtMs = this.now();
    const existing = this.shapes.get(shape);
    this.recordedCount += 1;

    if (!existing) {
      this.evictLeastSevereShapeIfAtCapacity();
      this.shapes.set(shape, {
        shape,
        count: 1,
        durationsMs: [info.durationMs],
        maxMs: info.durationMs,
        ...(info.rowCount === undefined ? {} : { maxRows: info.rowCount }),
        firstSeenAtMs: observedAtMs,
        lastSeenAtMs: observedAtMs,
      });
      return;
    }

    existing.count += 1;
    addReservoirSample(existing.durationsMs, info.durationMs, existing.count);
    existing.maxMs = Math.max(existing.maxMs, info.durationMs);
    if (info.rowCount !== undefined) {
      existing.maxRows = existing.maxRows === undefined
        ? info.rowCount
        : Math.max(existing.maxRows, info.rowCount);
    }
    existing.lastSeenAtMs = observedAtMs;
  }

  /** Bounds distinct shapes tracked by dropping the currently least-severe one. */
  private evictLeastSevereShapeIfAtCapacity(): void {
    if (this.shapes.size < MAX_TRACKED_SHAPES) return;
    let leastSevereKey: string | undefined;
    let leastSevereMaxMs = Infinity;
    for (const [key, stats] of this.shapes) {
      if (stats.maxMs < leastSevereMaxMs) {
        leastSevereMaxMs = stats.maxMs;
        leastSevereKey = key;
      }
    }
    if (leastSevereKey !== undefined) this.shapes.delete(leastSevereKey);
  }

  topN(n = 10): SlowQueryShapeStats[] {
    return [...this.shapes.values()]
      .map((stats) => snapshotStats(stats))
      .sort((left, right) =>
        right.maxMs - left.maxMs
        || right.count - left.count
        || left.shape.localeCompare(right.shape),
      )
      .slice(0, n);
  }

  reset(): void {
    this.shapes.clear();
    this.recordedCount = 0;
  }
}
