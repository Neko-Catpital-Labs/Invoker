export interface SlowQuerySample {
  durationMs: number;
  sql: string;
  rowCount?: number;
}

export interface SlowQueryShapeStats {
  shape: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface MutableSlowQueryShapeStats {
  shape: string;
  durationsMs: number[];
  maxMs: number;
  maxRows?: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SlowQueryAggregatorOptions {
  now?: () => Date;
}

const DEFAULT_TOP_N = 10;

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function isParamNameChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function readSingleQuotedLiteral(sql: string, start: number): number {
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

function readNumberLiteral(sql: string, start: number): number {
  const rest = sql.slice(start);
  const hexMatch = /^[+-]?0x[0-9a-fA-F]+/.exec(rest);
  if (hexMatch) return start + hexMatch[0].length;

  const decimalMatch = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/.exec(rest);
  if (decimalMatch) return start + decimalMatch[0].length;

  return start;
}

function startsNumberLiteral(sql: string, index: number): boolean {
  const current = sql[index];
  const next = sql[index + 1];
  if (current === '+' || current === '-') {
    return /[0-9.]/.test(next ?? '') && sql[index + 2] !== '.';
  }
  if (current === '.') return /[0-9]/.test(next ?? '');
  return /[0-9]/.test(current ?? '');
}

/**
 * Convert a SQL statement into a stable telemetry shape:
 * literals and bound params become `?`, repeated `IN` params collapse to one,
 * and insignificant whitespace/punctuation spacing is normalized.
 */
export function normalizeSlowQuerySql(sql: string): string {
  const out: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    const previous = sql[index - 1];

    if (
      (char === 'x' || char === 'X') &&
      sql[index + 1] === "'" &&
      !isIdentifierChar(previous)
    ) {
      out.push('?');
      index = readSingleQuotedLiteral(sql, index + 1);
      continue;
    }

    if (char === "'") {
      out.push('?');
      index = readSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '?') {
      out.push('?');
      index += 1;
      while (/[0-9]/.test(sql[index] ?? '')) index += 1;
      continue;
    }

    if ((char === ':' || char === '@' || char === '$') && isParamNameChar(sql[index + 1])) {
      out.push('?');
      index += 2;
      while (isParamNameChar(sql[index])) index += 1;
      continue;
    }

    if (startsNumberLiteral(sql, index) && !isIdentifierChar(previous)) {
      const end = readNumberLiteral(sql, index);
      if (end > index && !isIdentifierChar(sql[end])) {
        out.push('?');
        index = end;
        continue;
      }
    }

    out.push(char);
    index += 1;
  }

  return out.join('')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*(=|<>|!=|<=|>=|<|>)\s*/g, ' $1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi, 'IN (?)');
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;

  const rank = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sortedValues[lower]!;
  const upperValue = sortedValues[upper]!;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

export class SlowQueryAggregator {
  private readonly statsByShape = new Map<string, MutableSlowQueryShapeStats>();
  private readonly now: () => Date;

  constructor(options: SlowQueryAggregatorOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  record(info: SlowQuerySample): void {
    const shape = normalizeSlowQuerySql(info.sql);
    const seenAt = this.now().toISOString();
    const existing = this.statsByShape.get(shape);

    if (!existing) {
      this.statsByShape.set(shape, {
        shape,
        durationsMs: [info.durationMs],
        maxMs: info.durationMs,
        ...(info.rowCount === undefined ? {} : { maxRows: info.rowCount }),
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      });
      return;
    }

    existing.durationsMs.push(info.durationMs);
    existing.maxMs = Math.max(existing.maxMs, info.durationMs);
    if (info.rowCount !== undefined) {
      existing.maxRows = existing.maxRows === undefined
        ? info.rowCount
        : Math.max(existing.maxRows, info.rowCount);
    }
    existing.lastSeenAt = seenAt;
  }

  topN(n = DEFAULT_TOP_N): SlowQueryShapeStats[] {
    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) return [];

    return Array.from(this.statsByShape.values())
      .map((stats): SlowQueryShapeStats => {
        const sortedDurations = [...stats.durationsMs].sort((a, b) => a - b);
        return {
          shape: stats.shape,
          count: stats.durationsMs.length,
          p50Ms: percentile(sortedDurations, 50),
          p95Ms: percentile(sortedDurations, 95),
          maxMs: stats.maxMs,
          ...(stats.maxRows === undefined ? {} : { maxRows: stats.maxRows }),
          firstSeenAt: stats.firstSeenAt,
          lastSeenAt: stats.lastSeenAt,
        };
      })
      .sort((a, b) => (b.maxMs - a.maxMs) || (b.count - a.count) || a.shape.localeCompare(b.shape))
      .slice(0, limit);
  }

  reset(): void {
    this.statsByShape.clear();
  }
}
