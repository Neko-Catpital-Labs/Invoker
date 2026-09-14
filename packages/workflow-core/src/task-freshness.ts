import type { TaskFreshnessSpec } from '@invoker/workflow-graph';

const FRESHNESS_KEYS = new Set(['watchPaths', 'pathPreconditions', 'guardedBehaviorIds']);
const PATH_PRECONDITION_KEYS = new Set(['path', 'expected']);
const GUARDED_BEHAVIOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRepoRelativePath(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldLabel} must be a string`);
  }
  const normalized = value.trim();
  const segments = normalized.split('/');
  if (
    normalized === ''
    || normalized.length > 4096
    || normalized.startsWith('/')
    || normalized.includes('\\')
    || /[\x00-\x1f\x7f]/.test(normalized)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${fieldLabel} must be a normalized repo-relative path`);
  }
  return normalized;
}

function normalizePathList(value: unknown, fieldLabel: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldLabel} must be an array`);
  }
  return [...new Set(value.map((path, index) => normalizeRepoRelativePath(path, `${fieldLabel}[${index}]`)))]
    .sort(compareLexical);
}

function normalizeGuardedBehaviorIds(value: unknown, fieldLabel: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldLabel} must be an array`);
  }
  const ids = value.map((id, index) => {
    if (typeof id !== 'string' || !GUARDED_BEHAVIOR_ID_PATTERN.test(id.trim())) {
      throw new Error(
        `${fieldLabel}[${index}] must be an identifier containing only letters, numbers, underscores, or hyphens`,
      );
    }
    return id.trim();
  });
  return [...new Set(ids)].sort(compareLexical);
}

function normalizePathPreconditions(
  value: unknown,
  fieldLabel: string,
): Array<{ path: string; expected: 'present' | 'absent' }> {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldLabel} must be an array`);
  }
  const byPath = new Map<string, 'present' | 'absent'>();
  value.forEach((entry, index) => {
    const entryLabel = `${fieldLabel}[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    const unknownKey = Object.keys(entry).find((key) => !PATH_PRECONDITION_KEYS.has(key));
    if (unknownKey) {
      throw new Error(`${entryLabel} has unsupported field "${unknownKey}"`);
    }
    const path = normalizeRepoRelativePath(entry.path, `${entryLabel}.path`);
    if (entry.expected !== 'present' && entry.expected !== 'absent') {
      throw new Error(`${entryLabel}.expected must be "present" or "absent"`);
    }
    const previous = byPath.get(path);
    if (previous !== undefined && previous !== entry.expected) {
      throw new Error(`${fieldLabel} has conflicting expectations for path "${path}"`);
    }
    byPath.set(path, entry.expected);
  });
  return [...byPath.entries()]
    .sort(([left], [right]) => compareLexical(left, right))
    .map(([path, expected]) => ({ path, expected }));
}

export function parseTaskFreshnessSpec(value: unknown, ownerLabel: string): TaskFreshnessSpec | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${ownerLabel} "freshness" must be an object when provided`);
  }
  const unknownKey = Object.keys(value).find((key) => !FRESHNESS_KEYS.has(key));
  if (unknownKey) {
    throw new Error(`${ownerLabel} "freshness" has unsupported field "${unknownKey}"`);
  }

  return {
    ...(hasOwn(value, 'watchPaths')
      ? { watchPaths: normalizePathList(value.watchPaths, `${ownerLabel} freshness.watchPaths`) }
      : {}),
    ...(hasOwn(value, 'pathPreconditions')
      ? {
          pathPreconditions: normalizePathPreconditions(
            value.pathPreconditions,
            `${ownerLabel} freshness.pathPreconditions`,
          ),
        }
      : {}),
    ...(hasOwn(value, 'guardedBehaviorIds')
      ? {
          guardedBehaviorIds: normalizeGuardedBehaviorIds(
            value.guardedBehaviorIds,
            `${ownerLabel} freshness.guardedBehaviorIds`,
          ),
        }
      : {}),
  };
}
