import type { SlowQueryInfo } from './sqlite-adapter.js';

const DEFAULT_TOP_N = 10;

export interface SlowQueryAggregatorOptions {
  now?: () => number;
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

interface SlowQueryShapeStats {
  shape: string;
  count: number;
  durationsMs: number[];
  maxMs: number;
  maxRows?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export function normalizeSlowQuerySql(sql: string): string {
  let normalized = '';

  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    const next = sql[index + 1];

    if (isWhitespace(char)) {
      normalized += ' ';
      index += 1;
      while (index < sql.length && isWhitespace(sql[index])) index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      normalized += ' ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      normalized += ' ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, sql.length);
      continue;
    }

    if (char === "'") {
      normalized += '?';
      index = consumeSingleQuotedString(sql, index);
      continue;
    }

    if (char === '"' || char === '`') {
      const quoted = consumeQuotedIdentifier(sql, index, char);
      normalized += quoted.value;
      index = quoted.nextIndex;
      continue;
    }

    if (char === '[') {
      const quoted = consumeBracketIdentifier(sql, index);
      normalized += quoted.value;
      index = quoted.nextIndex;
      continue;
    }

    if (char === '?') {
      normalized += '?';
      index += 1;
      while (index < sql.length && isDigit(sql[index])) index += 1;
      continue;
    }

    if ((char === ':' || char === '@' || char === '$') && isParameterNameStart(next)) {
      normalized += '?';
      index += 2;
      while (index < sql.length && isIdentifierPart(sql[index])) index += 1;
      continue;
    }

    if (isNumberLiteralStart(sql, index)) {
      normalized += '?';
      index = consumeNumberLiteral(sql, index);
      continue;
    }

    normalized += char;
    index += 1;
  }

  return collapseInLists(normalizeSpacing(normalized));
}

export class SlowQueryAggregator {
  private readonly now: () => number;
  private readonly statsByShape = new Map<string, SlowQueryShapeStats>();
  private totalRecorded = 0;

  constructor(options: SlowQueryAggregatorOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get totalCount(): number {
    return this.totalRecorded;
  }

  get shapeCount(): number {
    return this.statsByShape.size;
  }

  record(info: SlowQueryInfo): void {
    const shape = normalizeSlowQuerySql(info.sql);
    const seenAt = this.now();
    const existing = this.statsByShape.get(shape);

    this.totalRecorded += 1;

    if (!existing) {
      this.statsByShape.set(shape, {
        shape,
        count: 1,
        durationsMs: [info.durationMs],
        maxMs: info.durationMs,
        ...(info.rowCount === undefined ? {} : { maxRows: info.rowCount }),
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      });
      return;
    }

    existing.count += 1;
    existing.durationsMs.push(info.durationMs);
    existing.maxMs = Math.max(existing.maxMs, info.durationMs);
    if (info.rowCount !== undefined) {
      existing.maxRows = existing.maxRows === undefined
        ? info.rowCount
        : Math.max(existing.maxRows, info.rowCount);
    }
    existing.lastSeenAt = seenAt;
  }

  topN(n = DEFAULT_TOP_N): SlowQueryShapeSummary[] {
    if (n <= 0) return [];

    return Array.from(this.statsByShape.values())
      .map(toSummary)
      .sort((a, b) => b.maxMs - a.maxMs || b.count - a.count || a.shape.localeCompare(b.shape))
      .slice(0, n);
  }

  reset(): void {
    this.statsByShape.clear();
    this.totalRecorded = 0;
  }
}

function toSummary(stats: SlowQueryShapeStats): SlowQueryShapeSummary {
  const sortedDurations = [...stats.durationsMs].sort((a, b) => a - b);
  return {
    shape: stats.shape,
    count: stats.count,
    p50Ms: nearestRankPercentile(sortedDurations, 50),
    p95Ms: nearestRankPercentile(sortedDurations, 95),
    maxMs: stats.maxMs,
    ...(stats.maxRows === undefined ? {} : { maxRows: stats.maxRows }),
    firstSeenAt: stats.firstSeenAt,
    lastSeenAt: stats.lastSeenAt,
  };
}

function nearestRankPercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sortedValues.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedValues.length - 1);
  return sortedValues[index] ?? 0;
}

function collapseInLists(sql: string): string {
  return sql.replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi, 'IN (?)');
}

function normalizeSpacing(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*(=|<>|!=|<=|>=|<|>)\s*/g, ' $1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

function consumeSingleQuotedString(sql: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (sql[index] === "'") return index + 1;
    index += 1;
  }
  return sql.length;
}

function consumeQuotedIdentifier(
  sql: string,
  startIndex: number,
  quote: '"' | '`',
): { value: string; nextIndex: number } {
  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      return { value: sql.slice(startIndex, index + 1), nextIndex: index + 1 };
    }
    index += 1;
  }
  return { value: sql.slice(startIndex), nextIndex: sql.length };
}

function consumeBracketIdentifier(sql: string, startIndex: number): { value: string; nextIndex: number } {
  let index = startIndex + 1;
  while (index < sql.length && sql[index] !== ']') index += 1;
  return { value: sql.slice(startIndex, Math.min(index + 1, sql.length)), nextIndex: Math.min(index + 1, sql.length) };
}

function consumeNumberLiteral(sql: string, startIndex: number): number {
  let index = startIndex;

  if (sql[index] === '.') {
    index += 1;
    while (index < sql.length && isDigitOrSeparator(sql[index])) index += 1;
    return consumeExponent(sql, index);
  }

  if (sql[index] === '0' && (sql[index + 1] === 'x' || sql[index + 1] === 'X')) {
    index += 2;
    while (index < sql.length && isHexDigitOrSeparator(sql[index])) index += 1;
    return index;
  }

  while (index < sql.length && isDigitOrSeparator(sql[index])) index += 1;
  if (sql[index] === '.') {
    index += 1;
    while (index < sql.length && isDigitOrSeparator(sql[index])) index += 1;
  }
  return consumeExponent(sql, index);
}

function consumeExponent(sql: string, startIndex: number): number {
  if (sql[startIndex] !== 'e' && sql[startIndex] !== 'E') return startIndex;

  let index = startIndex + 1;
  if (sql[index] === '+' || sql[index] === '-') index += 1;
  if (!isDigit(sql[index])) return startIndex;
  while (index < sql.length && isDigitOrSeparator(sql[index])) index += 1;
  return index;
}

function isNumberLiteralStart(sql: string, index: number): boolean {
  const char = sql[index];
  const previous = sql[index - 1];
  if (previous !== undefined && isIdentifierPart(previous)) return false;
  return isDigit(char) || (char === '.' && isDigit(sql[index + 1]));
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isDigitOrSeparator(char: string | undefined): boolean {
  return isDigit(char) || char === '_';
}

function isHexDigitOrSeparator(char: string | undefined): boolean {
  return char === '_' || (char !== undefined && /[0-9a-fA-F]/.test(char));
}

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isParameterNameStart(char: string | undefined): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}
