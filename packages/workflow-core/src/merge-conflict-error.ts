export interface ParsedMergeConflictError {
  failedBranch: string;
  conflictFiles: string[];
}

function isRecoverableConflictFile(file: string): boolean {
  return (
    file.length > 0
    && file !== '(see task output)'
    && !file.startsWith('at ')
    && !file.startsWith('[Ssh')
  );
}

function normalizeConflictFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file): file is string => typeof file === 'string')
    .map((file) => file.trim())
    .filter(isRecoverableConflictFile);
}

function fromJsonObject(value: unknown): ParsedMergeConflictError | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.type !== 'merge_conflict') return undefined;

  const failedBranch = typeof obj.failedBranch === 'string' ? obj.failedBranch.trim() : '';
  const conflictFiles = normalizeConflictFiles(obj.conflictFiles);
  if (!failedBranch || conflictFiles.length === 0) return undefined;
  return { failedBranch, conflictFiles };
}

function tryParseJson(value: string): ParsedMergeConflictError | undefined {
  try {
    return fromJsonObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function jsonCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = [trimmed, trimmed.split('\n\n').at(-1)?.trim() ?? ''];
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) candidates.push(trimmed.slice(jsonStart).trim());
  return candidates.filter((candidate) => candidate.length > 0);
}

function parseCommaSeparatedFiles(value: string): string[] {
  return value
    .split(',')
    .map((file) => file.trim())
    .filter(isRecoverableConflictFile);
}

function parseLineSeparatedFiles(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(isRecoverableConflictFile);
}

function parseLocalTextMergeConflict(value: string): ParsedMergeConflictError | undefined {
  const match = value.match(/Merge conflict merging\s+(.+?):\s*([^\n]+)/);
  const failedBranch = match?.[1]?.trim() ?? '';
  const conflictFiles = parseCommaSeparatedFiles(match?.[2] ?? '');
  if (!failedBranch || conflictFiles.length === 0) return undefined;
  return { failedBranch, conflictFiles };
}

function parseRemoteTextMergeConflict(value: string): ParsedMergeConflictError | undefined {
  const match = value.match(
    /Merge conflict merging upstream branch "([^"]+)" on remote\.\s*\r?\nConflicting files:\r?\n([\s\S]+)/,
  );
  const failedBranch = match?.[1]?.trim() ?? '';
  const conflictFiles = parseLineSeparatedFiles(match?.[2] ?? '');
  if (!failedBranch || conflictFiles.length === 0) return undefined;
  return { failedBranch, conflictFiles };
}

export function parseMergeConflictError(value: string | undefined): ParsedMergeConflictError | undefined {
  if (!value) return undefined;

  for (const candidate of jsonCandidates(value)) {
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed;
  }

  return parseRemoteTextMergeConflict(value) ?? parseLocalTextMergeConflict(value);
}
