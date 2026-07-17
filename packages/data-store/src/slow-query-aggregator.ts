export interface SlowQuerySample {
  durationMs: number;
  sql: string;
  rowCount?: number;
}

export interface SlowQuerySummaryEntry {
  shape: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface SlowQueryAccumulator {
  durationsMs: number[];
  count: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export interface SlowQueryAggregatorOptions {
  now?: () => number;
}

const DEFAULT_TOP_N = 10;

export function normalizeSlowQuerySql(sql: string): string {
  const normalized: string[] = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (isWhitespace(char)) {
      normalized.push(' ');
      i += 1;
      while (i < sql.length && isWhitespace(sql[i])) i += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      normalized.push(' ');
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      normalized.push(' ');
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, sql.length);
      continue;
    }

    if ((char === 'x' || char === 'X') && next === '\'' && !isIdentifierChar(sql[i - 1] ?? '')) {
      normalized.push('?');
      i = skipSingleQuoted(sql, i + 1);
      continue;
    }

    if (char === '\'') {
      normalized.push('?');
      i = skipSingleQuoted(sql, i);
      continue;
    }

    if (char === '?') {
      normalized.push('?');
      i += 1;
      while (i < sql.length && isDigit(sql[i])) i += 1;
      continue;
    }

    if ((char === ':' || char === '@' || char === '$') && isParameterNameStart(next ?? '')) {
      normalized.push('?');
      i += 2;
      while (i < sql.length && isParameterNamePart(sql[i])) i += 1;
      continue;
    }

    if (isSignedNumericLiteralStart(sql, i)) {
      normalized.push('?');
      i = skipNumericLiteral(sql, i + 1);
      continue;
    }

    if (isNumericLiteralStart(sql, i)) {
      normalized.push('?');
      i = skipNumericLiteral(sql, i);
      continue;
    }

    normalized.push(char);
    i += 1;
  }

  return normalized
    .join('')
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (?)')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SlowQueryAggregator {
  private readonly now: () => number;
  private readonly shapes = new Map<string, SlowQueryAccumulator>();
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

  record(info: SlowQuerySample): void {
    const shape = normalizeSlowQuerySql(info.sql);
    const seenAtMs = this.now();
    let accumulator = this.shapes.get(shape);
    if (!accumulator) {
      accumulator = {
        durationsMs: [],
        count: 0,
        maxMs: Number.NEGATIVE_INFINITY,
        firstSeenAtMs: seenAtMs,
        lastSeenAtMs: seenAtMs,
      };
      this.shapes.set(shape, accumulator);
    }

    accumulator.durationsMs.push(info.durationMs);
    accumulator.count += 1;
    accumulator.maxMs = Math.max(accumulator.maxMs, info.durationMs);
    accumulator.lastSeenAtMs = seenAtMs;
    if (info.rowCount !== undefined) {
      accumulator.maxRows = accumulator.maxRows === undefined
        ? info.rowCount
        : Math.max(accumulator.maxRows, info.rowCount);
    }
    this.recordedCount += 1;
  }

  topN(n = DEFAULT_TOP_N): SlowQuerySummaryEntry[] {
    const limit = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_TOP_N;
    return [...this.shapes.entries()]
      .map(([shape, accumulator]) => toSummaryEntry(shape, accumulator))
      .sort((a, b) => b.maxMs - a.maxMs || b.count - a.count || a.shape.localeCompare(b.shape))
      .slice(0, limit);
  }

  reset(): void {
    this.shapes.clear();
    this.recordedCount = 0;
  }
}

function toSummaryEntry(shape: string, accumulator: SlowQueryAccumulator): SlowQuerySummaryEntry {
  return {
    shape,
    count: accumulator.count,
    p50Ms: percentile(accumulator.durationsMs, 50),
    p95Ms: percentile(accumulator.durationsMs, 95),
    maxMs: accumulator.maxMs,
    ...(accumulator.maxRows === undefined ? {} : { maxRows: accumulator.maxRows }),
    firstSeenAt: new Date(accumulator.firstSeenAtMs).toISOString(),
    lastSeenAt: new Date(accumulator.lastSeenAtMs).toISOString(),
  };
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0] ?? 0;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentileRank / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

function skipSingleQuoted(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === '\'') {
      if (sql[i + 1] === '\'') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipNumericLiteral(sql: string, start: number): number {
  let i = start;
  if (sql[i] === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
    i += 2;
    while (i < sql.length && (isHexDigit(sql[i]) || sql[i] === '_')) i += 1;
    return i;
  }

  while (i < sql.length && (isDigit(sql[i]) || sql[i] === '_')) i += 1;
  if (sql[i] === '.') {
    i += 1;
    while (i < sql.length && (isDigit(sql[i]) || sql[i] === '_')) i += 1;
  }
  if (sql[i] === 'e' || sql[i] === 'E') {
    const exponentStart = i;
    i += 1;
    if (sql[i] === '+' || sql[i] === '-') i += 1;
    const digitStart = i;
    while (i < sql.length && (isDigit(sql[i]) || sql[i] === '_')) i += 1;
    if (i === digitStart) return exponentStart;
  }
  return i;
}

function isNumericLiteralStart(sql: string, index: number): boolean {
  const char = sql[index] ?? '';
  const previous = sql[index - 1] ?? '';
  const next = sql[index + 1] ?? '';
  if (isIdentifierChar(previous)) return false;
  if (isDigit(char)) return true;
  return char === '.' && isDigit(next);
}

function isSignedNumericLiteralStart(sql: string, index: number): boolean {
  const char = sql[index] ?? '';
  const next = sql[index + 1] ?? '';
  if (char !== '-' && char !== '+') return false;
  if (!isDigit(next) && !(next === '.' && isDigit(sql[index + 2]))) return false;

  const previous = previousNonWhitespace(sql, index);
  return previous === '' || '([{,=<>!*/%+-'.includes(previous);
}

function previousNonWhitespace(sql: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && isWhitespace(sql[i])) i -= 1;
  return sql[i] ?? '';
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /[0-9a-fA-F]/.test(char);
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isParameterNameStart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isParameterNamePart(char: string): boolean {
  return /[A-Za-z0-9_.$]/.test(char);
}
