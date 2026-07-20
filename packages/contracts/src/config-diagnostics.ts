export type ConfigDiagnosticSeverity = 'error' | 'warning';

export interface ConfigDiagnostic {
  severity: ConfigDiagnosticSeverity;
  path: string;
  message: string;
}

type UnknownRecord = Record<string, unknown>;

const POOL_MEMBER_TYPES = new Set(['ssh', 'worktree']);
const SELECTION_STRATEGIES = new Set(['roundRobin', 'leastLoaded']);
const ROUTING_STRATEGIES = new Set(['enforce', 'route']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

class DiagnosticCollector {
  readonly diagnostics: ConfigDiagnostic[] = [];

  error(path: string, message: string): void {
    this.diagnostics.push({ severity: 'error', path, message });
  }

  warning(path: string, message: string): void {
    this.diagnostics.push({ severity: 'warning', path, message });
  }
}

function checkRequiredString(collector: DiagnosticCollector, path: string, value: unknown): void {
  if (!isNonEmptyString(value)) {
    collector.error(path, `${path} must be a non-empty string`);
  }
}

function checkOptionalPositiveInteger(collector: DiagnosticCollector, path: string, value: unknown): void {
  if (value === undefined) return;
  if (!isPositiveInteger(value)) {
    collector.error(path, `${path} must be a positive integer, received ${JSON.stringify(value)}`);
  }
}

function checkRegex(collector: DiagnosticCollector, path: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    collector.error(path, `${path} must be a string`);
    return;
  }
  try {
    new RegExp(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collector.error(path, `${path} is not a valid regular expression: ${message}`);
  }
}

function collectRemoteTargetIds(collector: DiagnosticCollector, config: UnknownRecord): Set<string> {
  const ids = new Set<string>();
  const remoteTargets = config.remoteTargets;
  if (remoteTargets === undefined) return ids;
  if (!isRecord(remoteTargets)) {
    collector.error('remoteTargets', 'remoteTargets must be an object keyed by target id');
    return ids;
  }

  for (const [id, target] of Object.entries(remoteTargets)) {
    ids.add(id);
    const base = `remoteTargets.${id}`;
    if (!isRecord(target)) {
      collector.error(base, `${base} must be an object`);
      continue;
    }
    checkRequiredString(collector, `${base}.host`, target.host);
    checkRequiredString(collector, `${base}.user`, target.user);
    checkRequiredString(collector, `${base}.sshKeyPath`, target.sshKeyPath);
    checkOptionalPositiveInteger(collector, `${base}.maxConcurrentTasks`, target.maxConcurrentTasks);
    checkOptionalPositiveInteger(collector, `${base}.remoteHeartbeatIntervalSeconds`, target.remoteHeartbeatIntervalSeconds);

    if (target.port !== undefined && (!isPositiveInteger(target.port) || (target.port as number) > 65535)) {
      collector.error(`${base}.port`, `${base}.port must be an integer between 1 and 65535`);
    }
  }

  return ids;
}

function collectExecutionPoolIds(
  collector: DiagnosticCollector,
  config: UnknownRecord,
  remoteTargetIds: Set<string>,
): Set<string> {
  const poolIds = new Set<string>();
  const executionPools = config.executionPools;
  if (executionPools === undefined) return poolIds;
  if (!isRecord(executionPools)) {
    collector.error('executionPools', 'executionPools must be an object keyed by pool id');
    return poolIds;
  }

  const memberOwners = new Map<string, string[]>();

  for (const [poolId, pool] of Object.entries(executionPools)) {
    poolIds.add(poolId);
    const base = `executionPools.${poolId}`;
    if (!isRecord(pool)) {
      collector.error(base, `${base} must be an object`);
      continue;
    }

    checkOptionalPositiveInteger(collector, `${base}.maxConcurrentTasksPerMember`, pool.maxConcurrentTasksPerMember);
    if (pool.selectionStrategy !== undefined && !SELECTION_STRATEGIES.has(pool.selectionStrategy as string)) {
      collector.error(
        `${base}.selectionStrategy`,
        `${base}.selectionStrategy must be one of ${[...SELECTION_STRATEGIES].join(', ')}`,
      );
    }

    const members = pool.members;
    if (!Array.isArray(members)) {
      collector.error(`${base}.members`, `${base}.members must be an array`);
      continue;
    }
    if (members.length === 0) {
      collector.error(`${base}.members`, `${base}.members must list at least one member`);
      continue;
    }

    const seenInPool = new Set<string>();
    members.forEach((member, index) => {
      const memberPath = `${base}.members[${index}]`;
      if (!isRecord(member)) {
        collector.error(memberPath, `${memberPath} must be an object`);
        return;
      }

      const type = member.type;
      const id = member.id;
      if (!POOL_MEMBER_TYPES.has(type as string)) {
        collector.error(`${memberPath}.type`, `${memberPath}.type must be one of ${[...POOL_MEMBER_TYPES].join(', ')}`);
      }
      checkRequiredString(collector, `${memberPath}.id`, id);
      checkOptionalPositiveInteger(collector, `${memberPath}.maxConcurrentTasks`, member.maxConcurrentTasks);

      if (type === 'ssh' && isNonEmptyString(id) && !remoteTargetIds.has(id)) {
        collector.error(`${memberPath}.id`, `${memberPath}.id "${id}" has no matching entry in remoteTargets`);
      }

      if (!isNonEmptyString(id) || typeof type !== 'string') return;
      const key = `${type}:${id}`;
      if (seenInPool.has(key)) {
        collector.error(memberPath, `${memberPath} duplicates member ${key} already listed in ${base}`);
        return;
      }
      seenInPool.add(key);
      memberOwners.set(key, [...(memberOwners.get(key) ?? []), poolId]);
    });
  }

  for (const [key, owners] of memberOwners) {
    if (owners.length > 1) {
      collector.warning(
        'executionPools',
        `member ${key} appears in multiple pools (${owners.join(', ')}); capacity is de-duplicated to the highest declared value`,
      );
    }
  }

  return poolIds;
}

function checkPoolReference(
  collector: DiagnosticCollector,
  path: string,
  poolId: unknown,
  poolIds: Set<string>,
): void {
  if (!isNonEmptyString(poolId)) {
    collector.error(path, `${path} must be a non-empty string`);
    return;
  }
  if (!poolIds.has(poolId)) {
    collector.error(path, `${path} "${poolId}" is not a configured execution pool`);
  }
}

function checkRoutingRules(collector: DiagnosticCollector, config: UnknownRecord, poolIds: Set<string>): void {
  const rules = config.executorRoutingRules;
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    collector.error('executorRoutingRules', 'executorRoutingRules must be an array');
    return;
  }

  rules.forEach((rule, index) => {
    const base = `executorRoutingRules[${index}]`;
    if (!isRecord(rule)) {
      collector.error(base, `${base} must be an object`);
      return;
    }
    if (rule.pattern === undefined && rule.regex === undefined) {
      collector.error(base, `${base} must define either pattern or regex, otherwise it can never match`);
    }
    checkRegex(collector, `${base}.regex`, rule.regex);
    checkPoolReference(collector, `${base}.poolId`, rule.poolId, poolIds);
    if (rule.strategy !== undefined && !ROUTING_STRATEGIES.has(rule.strategy as string)) {
      collector.error(`${base}.strategy`, `${base}.strategy must be one of ${[...ROUTING_STRATEGIES].join(', ')}`);
    }
  });
}

function checkHeavyweightRouting(collector: DiagnosticCollector, config: UnknownRecord, poolIds: Set<string>): void {
  const routing = config.heavyweightCommandRouting;
  if (routing === undefined) return;
  if (!isRecord(routing)) {
    collector.error('heavyweightCommandRouting', 'heavyweightCommandRouting must be an object');
    return;
  }

  checkPoolReference(collector, 'heavyweightCommandRouting.poolId', routing.poolId, poolIds);

  const matchers = routing.matchers;
  if (matchers === undefined) return;
  if (!Array.isArray(matchers)) {
    collector.error('heavyweightCommandRouting.matchers', 'heavyweightCommandRouting.matchers must be an array');
    return;
  }
  matchers.forEach((matcher, index) => {
    const base = `heavyweightCommandRouting.matchers[${index}]`;
    if (!isRecord(matcher)) {
      collector.error(base, `${base} must be an object`);
      return;
    }
    if (matcher.pattern === undefined && matcher.regex === undefined) {
      collector.error(base, `${base} must define either pattern or regex, otherwise it can never match`);
    }
    checkRegex(collector, `${base}.regex`, matcher.regex);
  });
}

export function collectInvokerConfigDiagnostics(config: unknown): ConfigDiagnostic[] {
  const collector = new DiagnosticCollector();
  if (!isRecord(config)) {
    collector.error('', 'Invoker config must be a JSON object');
    return collector.diagnostics;
  }

  checkOptionalPositiveInteger(collector, 'maxConcurrency', config.maxConcurrency);

  const remoteTargetIds = collectRemoteTargetIds(collector, config);
  const poolIds = collectExecutionPoolIds(collector, config, remoteTargetIds);

  if (config.defaultPoolId !== undefined) {
    checkPoolReference(collector, 'defaultPoolId', config.defaultPoolId, poolIds);
  }

  checkRoutingRules(collector, config, poolIds);
  checkHeavyweightRouting(collector, config, poolIds);

  return collector.diagnostics;
}

export function hasBlockingConfigDiagnostic(diagnostics: readonly ConfigDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
