export interface SlowQueryAggregateInput {
  durationMs: number;
  sql: string;
  rowCount?: number;
}

export interface SlowQueryShapeSummary {
  shape: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  maxRows?: number;
  firstSeenAt: number;
  lastSeenAt: number;
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

export interface SlowQueryAggregatorOptions {
  now?: () => number;
  defaultTopN?: number;
}

const DEFAULT_TOP_N = 10;

export function normalizeSqlShape(sql: string): string {
  return replaceSqlLiteralsAndParams(sql)
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/giu, 'IN (?)')
    .replace(/\s+/gu, ' ')
    .trim();
}

export class SlowQueryAggregator {
  private readonly now: () => number;
  private readonly defaultTopN: number;
  private readonly byShape = new Map<string, SlowQueryShapeAccumulator>();

  constructor(options: SlowQueryAggregatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTopN = options.defaultTopN ?? DEFAULT_TOP_N;
  }

  record(info: SlowQueryAggregateInput): void {
    const shape = normalizeSqlShape(info.sql);
    const observedAt = this.now();
    const existing = this.byShape.get(shape);

    if (existing) {
      existing.count += 1;
      existing.durationsMs.push(info.durationMs);
      existing.maxMs = Math.max(existing.maxMs, info.durationMs);
      existing.lastSeenAt = observedAt;
      if (info.rowCount !== undefined) {
        existing.maxRows = existing.maxRows === undefined
          ? info.rowCount
          : Math.max(existing.maxRows, info.rowCount);
      }
      return;
    }

    this.byShape.set(shape, {
      shape,
      durationsMs: [info.durationMs],
      count: 1,
      maxMs: info.durationMs,
      ...(info.rowCount === undefined ? {} : { maxRows: info.rowCount }),
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    });
  }

  topN(n: number = this.defaultTopN): SlowQueryShapeSummary[] {
    return [...this.byShape.values()]
      .map((entry) => summarizeShape(entry))
      .sort((a, b) => (
        b.maxMs - a.maxMs
        || b.count - a.count
        || a.shape.localeCompare(b.shape)
      ))
      .slice(0, Math.max(0, n));
  }

  reset(): void {
    this.byShape.clear();
  }
}

function summarizeShape(entry: SlowQueryShapeAccumulator): SlowQueryShapeSummary {
  return {
    shape: entry.shape,
    count: entry.count,
    p50Ms: percentileNearestRank(entry.durationsMs, 50),
    p95Ms: percentileNearestRank(entry.durationsMs, 95),
    maxMs: entry.maxMs,
    ...(entry.maxRows === undefined ? {} : { maxRows: entry.maxRows }),
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
  };
}

function percentileNearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))] ?? 0;
}

function replaceSqlLiteralsAndParams(sql: string): string {
  let normalized = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if ((char === 'x' || char === 'X') && next === "'") {
      normalized += '?';
      index = skipSingleQuotedString(sql, index + 1);
      continue;
    }

    if (char === "'") {
      normalized += '?';
      index = skipSingleQuotedString(sql, index);
      continue;
    }

    if (char === '?') {
      normalized += '?';
      index += 1;
      while (isDigit(sql[index])) index += 1;
      continue;
    }

    if ((char === ':' || char === '@' || char === '$') && (isIdentifierStart(next) || isDigit(next))) {
      normalized += '?';
      index += 2;
      while (isIdentifierPart(sql[index])) index += 1;
      continue;
    }

    if (isNumericLiteralStart(sql, index)) {
      normalized += '?';
      index = skipNumericLiteral(sql, index);
      continue;
    }

    normalized += char;
    index += 1;
  }

  return normalized;
}

function skipSingleQuotedString(sql: string, quoteIndex: number): number {
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

function isNumericLiteralStart(sql: string, index: number): boolean {
  const char = sql[index];
  const next = sql[index + 1];
  const previous = sql[index - 1];

  if ((char === '+' || char === '-') && (isDigit(next) || (next === '.' && isDigit(sql[index + 2])))) {
    return canStartSignedNumber(previousNonWhitespace(sql, index));
  }

  if (char === '.' && isDigit(next)) {
    return !isIdentifierPart(previous);
  }

  return isDigit(char) && !isIdentifierPart(previous);
}

function skipNumericLiteral(sql: string, startIndex: number): number {
  let index = startIndex;

  if (sql[index] === '+' || sql[index] === '-') {
    index += 1;
  }

  if (sql[index] === '0' && (sql[index + 1] === 'x' || sql[index + 1] === 'X')) {
    index += 2;
    while (isHexDigit(sql[index])) index += 1;
    return index;
  }

  while (isDigit(sql[index])) index += 1;

  if (sql[index] === '.') {
    index += 1;
    while (isDigit(sql[index])) index += 1;
  }

  if (sql[index] === 'e' || sql[index] === 'E') {
    const exponentStart = index;
    index += 1;
    if (sql[index] === '+' || sql[index] === '-') index += 1;
    const digitStart = index;
    while (isDigit(sql[index])) index += 1;
    if (digitStart === index) return exponentStart;
  }

  return index;
}

function previousNonWhitespace(sql: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = sql[cursor];
    if (char !== undefined && !/\s/u.test(char)) return char;
  }
  return undefined;
}

function canStartSignedNumber(previous: string | undefined): boolean {
  return previous === undefined || /\s|[(,=<>!+\-*/%]/u.test(previous);
}

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/u.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/u.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && /[0-9]/u.test(char);
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /[0-9A-Fa-f]/u.test(char);
}
