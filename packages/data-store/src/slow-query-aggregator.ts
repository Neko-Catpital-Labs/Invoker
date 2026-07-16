export interface SlowQueryAggregatorInput {
  durationMs: number;
  sql: string;
  rowCount?: number;
}

export interface SlowQuerySummary {
  sqlShape: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SlowQueryAggregatorOptions {
  now?: () => number;
}

interface SlowQueryShapeAccumulator {
  sqlShape: string;
  durationsMs: number[];
  count: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export const DEFAULT_SLOW_QUERY_TOP_N = 10;

const PARAMETER_NAME = /^[A-Za-z0-9_]+/;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function scanStringLiteral(sql: string, start: number): number {
  let index = start + 1;
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

function scanNumberLiteral(sql: string, start: number): number {
  let index = start;

  if (sql[index] === '0' && (sql[index + 1] === 'x' || sql[index + 1] === 'X')) {
    index += 2;
    while (/[0-9A-Fa-f]/.test(sql[index] ?? '')) index += 1;
    return index;
  }

  while (isDigit(sql[index])) index += 1;

  if (sql[index] === '.') {
    index += 1;
    while (isDigit(sql[index])) index += 1;
  }

  if (sql[index] === 'e' || sql[index] === 'E') {
    let exponentIndex = index + 1;
    if (sql[exponentIndex] === '+' || sql[exponentIndex] === '-') exponentIndex += 1;
    if (isDigit(sql[exponentIndex])) {
      index = exponentIndex + 1;
      while (isDigit(sql[index])) index += 1;
    }
  }

  return index;
}

function scanParameter(sql: string, start: number): number | null {
  const marker = sql[start];
  if (marker === '?') {
    let index = start + 1;
    while (isDigit(sql[index])) index += 1;
    return index;
  }

  if (marker !== ':' && marker !== '@' && marker !== '$') return null;

  const rest = sql.slice(start + 1);
  const match = PARAMETER_NAME.exec(rest);
  return match ? start + 1 + match[0].length : null;
}

/**
 * Converts concrete SQL into a stable shape key suitable for aggregation.
 * This is intentionally lexical rather than a full SQL parser: it strips the
 * volatile values that explode cardinality while preserving table/column shape.
 */
export function normalizeSlowQuerySql(sql: string): string {
  const output: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      output.push(' ');
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(sql.length, index + 2);
      output.push(' ');
      continue;
    }

    if ((char === 'x' || char === 'X') && next === "'" && !isIdentifierChar(sql[index - 1])) {
      output.push('?');
      index = scanStringLiteral(sql, index + 1);
      continue;
    }

    if (char === "'") {
      output.push('?');
      index = scanStringLiteral(sql, index);
      continue;
    }

    const parameterEnd = scanParameter(sql, index);
    if (parameterEnd !== null) {
      output.push('?');
      index = parameterEnd;
      continue;
    }

    if ((isDigit(char) || (char === '.' && isDigit(next))) && !isIdentifierChar(sql[index - 1])) {
      output.push('?');
      index = scanNumberLiteral(sql, index);
      continue;
    }

    output.push(char);
    index += 1;
  }

  return output
    .join('')
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi, 'IN (?)')
    .replace(/\s+/g, ' ')
    .trim();
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;

  const rank = (percentileValue / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

function summarize(accumulator: SlowQueryShapeAccumulator): SlowQuerySummary {
  const sortedDurations = [...accumulator.durationsMs].sort((a, b) => a - b);
  return {
    sqlShape: accumulator.sqlShape,
    count: accumulator.count,
    p50Ms: percentile(sortedDurations, 50),
    p95Ms: percentile(sortedDurations, 95),
    maxMs: accumulator.maxMs,
    ...(accumulator.maxRows === undefined ? {} : { maxRows: accumulator.maxRows }),
    firstSeenAt: accumulator.firstSeenAt,
    lastSeenAt: accumulator.lastSeenAt,
  };
}

export class SlowQueryAggregator {
  private readonly shapes = new Map<string, SlowQueryShapeAccumulator>();
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

  record(info: SlowQueryAggregatorInput): void {
    const sqlShape = normalizeSlowQuerySql(info.sql);
    const seenAt = this.now();
    let accumulator = this.shapes.get(sqlShape);

    if (!accumulator) {
      accumulator = {
        sqlShape,
        durationsMs: [],
        count: 0,
        maxMs: info.durationMs,
        ...(info.rowCount === undefined ? {} : { maxRows: info.rowCount }),
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      };
      this.shapes.set(sqlShape, accumulator);
    }

    accumulator.durationsMs.push(info.durationMs);
    accumulator.count += 1;
    accumulator.maxMs = Math.max(accumulator.maxMs, info.durationMs);
    if (info.rowCount !== undefined) {
      accumulator.maxRows = accumulator.maxRows === undefined
        ? info.rowCount
        : Math.max(accumulator.maxRows, info.rowCount);
    }
    accumulator.lastSeenAt = seenAt;
    this.recordedCount += 1;
  }

  topN(n: number = DEFAULT_SLOW_QUERY_TOP_N): SlowQuerySummary[] {
    return [...this.shapes.values()]
      .map((accumulator) => summarize(accumulator))
      .sort((a, b) => {
        const maxDelta = b.maxMs - a.maxMs;
        if (maxDelta !== 0) return maxDelta;
        const countDelta = b.count - a.count;
        if (countDelta !== 0) return countDelta;
        return a.sqlShape.localeCompare(b.sqlShape);
      })
      .slice(0, n);
  }

  reset(): void {
    this.shapes.clear();
    this.recordedCount = 0;
  }
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function truncateSqlShape(sqlShape: string): string {
  return sqlShape.length <= 220 ? sqlShape : `${sqlShape.slice(0, 217)}...`;
}

export function formatSlowQuerySummary(
  rows: readonly SlowQuerySummary[],
  options: { thresholdMs?: number; totalCount?: number; shapeCount?: number } = {},
): string {
  const threshold = options.thresholdMs === undefined ? '' : ` threshold=${formatMs(options.thresholdMs)}ms`;
  const totals = [
    options.totalCount === undefined ? null : `samples=${options.totalCount}`,
    options.shapeCount === undefined ? null : `shapes=${options.shapeCount}`,
  ].filter((item): item is string => item !== null);
  const suffix = totals.length === 0 ? '' : ` ${totals.join(' ')}`;
  const header = `[SQLiteAdapter] slow query summary${threshold}${suffix}`;

  if (rows.length === 0) return `${header}\n(no slow queries recorded)`;

  return [
    header,
    ...rows.map((row, index) => {
      const maxRows = row.maxRows === undefined ? '' : ` maxRows=${row.maxRows}`;
      return `${index + 1}. max=${formatMs(row.maxMs)}ms p95=${formatMs(row.p95Ms)}ms p50=${formatMs(row.p50Ms)}ms count=${row.count}${maxRows} first=${formatTimestamp(row.firstSeenAt)} last=${formatTimestamp(row.lastSeenAt)} sql=${truncateSqlShape(row.sqlShape)}`;
    }),
  ].join('\n');
}
