export interface SlowQueryInfo {
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
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SlowQueryAggregatorOptions {
  defaultLimit?: number;
  now?: () => number;
}

interface SlowQueryShapeAccumulator {
  shape: string;
  durationsMs: number[];
  count: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

const DEFAULT_TOP_N = 10;

const BLOB_LITERAL_PATTERN = /\b[xX]'(?:''|[^'])*'/g;
const STRING_LITERAL_PATTERN = /'(?:''|[^'])*'/g;
const PARAMETER_PATTERN = /\?(?:\d+)?|[:@$][A-Za-z_][A-Za-z0-9_]*/g;
const NUMBER_LITERAL_PATTERN =
  /(?<![\w])[-+]?(?:0x[0-9a-f]+|(?:\d+\.\d*|\.\d+|\d+)(?:e[-+]?\d+)?)(?![\w])/gi;
const IN_PARAMETER_LIST_PATTERN = /\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi;

export function normalizeSlowQuerySql(sql: string): string {
  return stripSqlComments(sql)
    .replace(BLOB_LITERAL_PATTERN, '?')
    .replace(STRING_LITERAL_PATTERN, '?')
    .replace(PARAMETER_PATTERN, '?')
    .replace(NUMBER_LITERAL_PATTERN, '?')
    .replace(/\s+/g, ' ')
    .replace(/\s*=\s*/g, ' = ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(IN_PARAMETER_LIST_PATTERN, 'IN (?)')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSqlComments(sql: string): string {
  let normalized = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      normalized += ' ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      normalized += ' ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(sql.length, index + 2);
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      const consumed = consumeQuotedSql(sql, index, char);
      normalized += sql.slice(index, consumed);
      index = consumed;
      continue;
    }

    if (char === '[') {
      const consumed = consumeBracketQuotedIdentifier(sql, index);
      normalized += sql.slice(index, consumed);
      index = consumed;
      continue;
    }

    normalized += char;
    index += 1;
  }

  return normalized;
}

function consumeQuotedSql(sql: string, startIndex: number, quote: string): number {
  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function consumeBracketQuotedIdentifier(sql: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] !== ']') {
      index += 1;
      continue;
    }
    if (sql[index + 1] === ']') {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function percentileNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index] ?? 0;
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function truncateSql(sql: string, maxLength: number): string {
  return sql.length <= maxLength ? sql : `${sql.slice(0, maxLength - 1)}...`;
}

export function formatSlowQuerySummary(
  stats: SlowQueryShapeStats[],
  options: { totalCount?: number; totalShapes?: number; limit?: number } = {},
): string {
  const totalCount = options.totalCount ?? stats.reduce((sum, stat) => sum + stat.count, 0);
  const totalShapes = options.totalShapes ?? stats.length;
  const limit = options.limit ?? stats.length;
  const lines = [
    `[SQLiteAdapter] slow query summary: top ${Math.min(limit, stats.length)} of ${totalShapes} shapes (${totalCount} samples)`,
  ];

  for (const [index, stat] of stats.entries()) {
    lines.push(
      `${index + 1}. max=${formatMs(stat.maxMs)}ms p95=${formatMs(stat.p95Ms)}ms p50=${formatMs(stat.p50Ms)}ms` +
        ` count=${stat.count}` +
        (stat.maxRows === undefined ? '' : ` maxRows=${stat.maxRows}`) +
        ` first=${new Date(stat.firstSeenAt).toISOString()}` +
        ` last=${new Date(stat.lastSeenAt).toISOString()}` +
        ` sql=${truncateSql(stat.shape, 240)}`,
    );
  }

  return lines.join('\n');
}

export class SlowQueryAggregator {
  private readonly defaultLimit: number;
  private readonly now: () => number;
  private readonly shapes = new Map<string, SlowQueryShapeAccumulator>();
  private totalSamples = 0;

  constructor(options: SlowQueryAggregatorOptions = {}) {
    this.defaultLimit = options.defaultLimit ?? DEFAULT_TOP_N;
    this.now = options.now ?? Date.now;
  }

  record(info: SlowQueryInfo): void {
    if (!Number.isFinite(info.durationMs)) return;

    const shape = normalizeSlowQuerySql(info.sql);
    const seenAt = this.now();
    let stats = this.shapes.get(shape);
    if (!stats) {
      stats = {
        shape,
        durationsMs: [],
        count: 0,
        maxMs: info.durationMs,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      };
      this.shapes.set(shape, stats);
    }

    stats.durationsMs.push(info.durationMs);
    stats.count += 1;
    stats.maxMs = Math.max(stats.maxMs, info.durationMs);
    if (info.rowCount !== undefined && Number.isFinite(info.rowCount)) {
      stats.maxRows = Math.max(stats.maxRows ?? info.rowCount, info.rowCount);
    }
    stats.lastSeenAt = seenAt;
    this.totalSamples += 1;
  }

  topN(n: number = this.defaultLimit): SlowQueryShapeStats[] {
    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) return [];

    return [...this.shapes.values()]
      .map((stats) => ({
        shape: stats.shape,
        count: stats.count,
        p50Ms: percentileNearestRank(stats.durationsMs, 50),
        p95Ms: percentileNearestRank(stats.durationsMs, 95),
        maxMs: stats.maxMs,
        ...(stats.maxRows === undefined ? {} : { maxRows: stats.maxRows }),
        firstSeenAt: stats.firstSeenAt,
        lastSeenAt: stats.lastSeenAt,
      }))
      .sort((a, b) => b.maxMs - a.maxMs || b.count - a.count || a.shape.localeCompare(b.shape))
      .slice(0, limit);
  }

  summary(n: number = this.defaultLimit): string {
    return formatSlowQuerySummary(this.topN(n), {
      totalCount: this.totalSamples,
      totalShapes: this.shapes.size,
      limit: Math.max(0, Math.floor(n)),
    });
  }

  reset(): void {
    this.shapes.clear();
    this.totalSamples = 0;
  }
}
