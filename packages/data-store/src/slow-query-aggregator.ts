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
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SlowQueryAggregatorOptions {
  defaultTopN?: number;
  now?: () => number;
}

interface MutableSlowQueryShapeStats {
  shape: string;
  durationsMs: number[];
  count: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

const DEFAULT_TOP_N = 10;

export function normalizeSlowQuerySql(sql: string): string {
  const normalized = replaceSqlLiteralsAndParams(sql)
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi, 'IN (?)')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

export class SlowQueryAggregator {
  private readonly defaultTopN: number;
  private readonly now: () => number;
  private readonly byShape = new Map<string, MutableSlowQueryShapeStats>();

  constructor(options: SlowQueryAggregatorOptions = {}) {
    this.defaultTopN = options.defaultTopN ?? DEFAULT_TOP_N;
    this.now = options.now ?? Date.now;
  }

  record(info: SlowQueryInfo): void {
    const shape = normalizeSlowQuerySql(info.sql);
    const seenAtMs = this.now();
    let stats = this.byShape.get(shape);
    if (!stats) {
      stats = {
        shape,
        durationsMs: [],
        count: 0,
        maxMs: info.durationMs,
        ...(info.rowCount === undefined ? {} : { maxRows: info.rowCount }),
        firstSeenAtMs: seenAtMs,
        lastSeenAtMs: seenAtMs,
      };
      this.byShape.set(shape, stats);
    }

    stats.durationsMs.push(info.durationMs);
    stats.count += 1;
    stats.maxMs = Math.max(stats.maxMs, info.durationMs);
    if (info.rowCount !== undefined) {
      stats.maxRows = stats.maxRows === undefined
        ? info.rowCount
        : Math.max(stats.maxRows, info.rowCount);
    }
    stats.lastSeenAtMs = seenAtMs;
  }

  topN(n: number = this.defaultTopN): SlowQueryShapeStats[] {
    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) return [];

    return [...this.byShape.values()]
      .map(toPublicStats)
      .sort((a, b) =>
        b.maxMs - a.maxMs
        || b.count - a.count
        || b.p95Ms - a.p95Ms
        || a.shape.localeCompare(b.shape),
      )
      .slice(0, limit);
  }

  reset(): void {
    this.byShape.clear();
  }
}

export function formatSlowQuerySummary(entries: readonly SlowQueryShapeStats[]): string {
  if (entries.length === 0) {
    return '[SQLiteAdapter] slow query summary: no slow queries recorded';
  }

  return `[SQLiteAdapter] slow query summary top=${entries.length}: `
    + entries.map((entry, index) => {
      const rows = entry.maxRows === undefined ? '' : ` maxRows=${entry.maxRows}`;
      return `#${index + 1} max=${formatMs(entry.maxMs)} p95=${formatMs(entry.p95Ms)} `
        + `p50=${formatMs(entry.p50Ms)} count=${entry.count}${rows} `
        + `first=${entry.firstSeenAt} last=${entry.lastSeenAt} sql="${truncate(entry.shape, 240)}"`;
    }).join('; ');
}

function replaceSqlLiteralsAndParams(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'") {
      out += '?';
      i = skipSingleQuotedString(sql, i + 1);
      continue;
    }

    if (ch === '?' && isDigit(next)) {
      out += '?';
      i += 2;
      while (i < sql.length && isDigit(sql[i])) i += 1;
      continue;
    }

    if (ch === '?') {
      out += '?';
      i += 1;
      continue;
    }

    if ((ch === ':' || ch === '@' || ch === '$') && isIdentifierStart(next)) {
      out += '?';
      i += 2;
      while (i < sql.length && isIdentifierPart(sql[i])) i += 1;
      continue;
    }

    if (isNumericLiteralStart(sql, i)) {
      out += '?';
      i = skipNumericLiteral(sql, ch === '-' || ch === '+' ? i + 1 : i);
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function skipSingleQuotedString(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function isNumericLiteralStart(sql: string, index: number): boolean {
  const ch = sql[index];
  const next = sql[index + 1];
  const prev = index === 0 ? '' : sql[index - 1];

  if ((ch === '-' || ch === '+') && isDigit(next)) {
    return !isIdentifierPart(prev);
  }

  if (!isDigit(ch)) return false;
  return !isIdentifierPart(prev);
}

function skipNumericLiteral(sql: string, start: number): number {
  let i = start;

  if (sql[i] === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
    i += 2;
    while (i < sql.length && /[0-9a-fA-F]/.test(sql[i])) i += 1;
    return i;
  }

  while (i < sql.length && isDigit(sql[i])) i += 1;

  if (sql[i] === '.') {
    i += 1;
    while (i < sql.length && isDigit(sql[i])) i += 1;
  }

  if (sql[i] === 'e' || sql[i] === 'E') {
    const exponentStart = i;
    i += 1;
    if (sql[i] === '-' || sql[i] === '+') i += 1;
    const digitsStart = i;
    while (i < sql.length && isDigit(sql[i])) i += 1;
    if (i === digitsStart) return exponentStart;
  }

  return i;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function toPublicStats(stats: MutableSlowQueryShapeStats): SlowQueryShapeStats {
  const sorted = [...stats.durationsMs].sort((a, b) => a - b);
  return {
    shape: stats.shape,
    count: stats.count,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: stats.maxMs,
    ...(stats.maxRows === undefined ? {} : { maxRows: stats.maxRows }),
    firstSeenAt: new Date(stats.firstSeenAtMs).toISOString(),
    lastSeenAt: new Date(stats.lastSeenAtMs).toISOString(),
  };
}

function percentile(sortedValues: readonly number[], percentileRank: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;

  const position = (percentileRank / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
