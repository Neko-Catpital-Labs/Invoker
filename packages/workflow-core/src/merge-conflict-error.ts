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
function normalizeNewlines(value: string): string {
  return value.split('\r\n').join('\n');
}


function parseLocalTextMergeConflict(value: string): ParsedMergeConflictError | undefined {
  const prefix = 'Merge conflict merging';
  const prefixIndex = value.indexOf(prefix);
  if (prefixIndex < 0) return undefined;
  const afterPrefix = value.slice(prefixIndex + prefix.length).trimStart();
  const colonIndex = afterPrefix.indexOf(':');
  if (colonIndex <= 0) return undefined;
  const failedBranch = afterPrefix.slice(0, colonIndex).trim();
  const conflictLine = afterPrefix.slice(colonIndex + 1).split('\n', 1)[0]?.trim() ?? '';
  const conflictFiles = parseCommaSeparatedFiles(conflictLine);
  if (!failedBranch || conflictFiles.length === 0) return undefined;
  return { failedBranch, conflictFiles };
}

function parseRemoteTextMergeConflict(value: string): ParsedMergeConflictError | undefined {
  const normalized = normalizeNewlines(value);
  const prefix = 'Merge conflict merging upstream branch "';
  const prefixIndex = normalized.indexOf(prefix);
  if (prefixIndex < 0) return undefined;
  const branchStart = prefixIndex + prefix.length;
  const branchEnd = normalized.indexOf('" on remote.\nConflicting files:\n', branchStart);
  if (branchEnd < 0) return undefined;
  const failedBranch = normalized.slice(branchStart, branchEnd).trim();
  const filesStart = branchEnd + '" on remote.\nConflicting files:\n'.length;
  const conflictFiles = parseLineSeparatedFiles(normalized.slice(filesStart));
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
