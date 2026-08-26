import { assertExecutionModelSupported, registerBuiltinAgents } from '@invoker/execution-engine';
import {
  normalizeGithubOwnerRepo,
  type CrossRepoResearchConfig,
  type CrossRepoResearchSource,
  type InvokerConfig,
  type MergifyQueueResearchConfig,
  type MergifyQueueResearchSource,
  DEFAULT_CROSS_REPO_RESEARCH_LOOKBACK_DAYS,
  DEFAULT_MERGIFY_QUEUE_RESEARCH_LOOKBACK_DAYS,
} from './config.js';

const builtinAgents = registerBuiltinAgents();

function validateConfiguredModel(agentName: string | undefined, executionModel: string | undefined): void {
  const normalizedAgent = agentName?.trim();
  const normalizedModel = executionModel?.trim();
  if (!normalizedAgent || !normalizedModel) return;
  const agent = builtinAgents.get(normalizedAgent);
  if (!agent) return;
  assertExecutionModelSupported(agent, normalizedModel);
}

function validatePrMaintenanceTargetRepos(config: InvokerConfig): void {
  const targetRepos = config.prMaintenance?.targetRepos;
  if (targetRepos === undefined) return;
  if (!Array.isArray(targetRepos)) {
    throw new Error('prMaintenance.targetRepos must be an array of "owner/repo" strings');
  }
  for (const entry of targetRepos) {
    if (typeof entry !== 'string' || !normalizeGithubOwnerRepo(entry)) {
      throw new Error(
        `prMaintenance.targetRepos entries must be "owner/repo" strings; got ${JSON.stringify(entry)}`,
      );
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const HTTP_GIT_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s/]+\/[^\s/]+/i;
const SSH_GIT_URL_RE = /^ssh:\/\/(?:[^\s@/]+@)?[^\s/]+\.[^\s/]+\/[^\s/]+\/[^\s/]+/i;
const SCP_GIT_URL_RE = /^git@[^\s:]+\.[^\s:]+:[^\s/]+\/[^\s/]+/i;

function isGitUrl(value: string): boolean {
  const trimmed = value.trim();
  return HTTP_GIT_URL_RE.test(trimmed) || SSH_GIT_URL_RE.test(trimmed) || SCP_GIT_URL_RE.test(trimmed);
}

function validateCrossRepoResearchSource(entry: unknown, path: string): void {
  if (typeof entry === 'string') {
    if (!isGitUrl(entry)) {
      throw new Error(`${path} must be a git URL string; got ${JSON.stringify(entry)}`);
    }
    return;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${path} must be a git URL string or { repoUrl, lookbackDays? }`);
  }
  const source = entry as CrossRepoResearchSource;
  if (!isNonEmptyString(source.repoUrl) || !isGitUrl(source.repoUrl)) {
    throw new Error(`${path}.repoUrl must be a git URL string`);
  }
  if (source.lookbackDays !== undefined) {
    if (typeof source.lookbackDays !== 'number' || !Number.isInteger(source.lookbackDays) || source.lookbackDays <= 0) {
      throw new Error(`${path}.lookbackDays must be an integer > 0`);
    }
  }
}

function validateE2eAutoFixTargetRepos(config: InvokerConfig): void {
  const targetRepos = config.e2eAutoFix?.targetRepos;
  if (targetRepos === undefined) return;
  if (!Array.isArray(targetRepos)) {
    throw new Error('e2eAutoFix.targetRepos must be an array of "owner/repo" strings');
  }
  for (const entry of targetRepos) {
    if (typeof entry !== 'string' || !normalizeGithubOwnerRepo(entry)) {
      throw new Error(
        `e2eAutoFix.targetRepos entries must be "owner/repo" strings; got ${JSON.stringify(entry)}`,
      );
    }
  }
}

function validateCrossRepoResearchConfig(config: InvokerConfig): void {
  const crossRepoResearch = config.crossRepoResearch;
  if (crossRepoResearch === undefined) return;
  if (typeof crossRepoResearch !== 'object' || crossRepoResearch === null || Array.isArray(crossRepoResearch)) {
    throw new Error('crossRepoResearch must be an object');
  }
  const typed = crossRepoResearch as CrossRepoResearchConfig;
  if (typed.intervalDays !== undefined) {
    if (typeof typed.intervalDays !== 'number' || !Number.isInteger(typed.intervalDays) || typed.intervalDays <= 0) {
      throw new Error('crossRepoResearch.intervalDays must be an integer > 0');
    }
  }
  if (typed.maxCandidatesPerSource !== undefined) {
    if (
      typeof typed.maxCandidatesPerSource !== 'number'
      || !Number.isInteger(typed.maxCandidatesPerSource)
      || typed.maxCandidatesPerSource <= 0
    ) {
      throw new Error('crossRepoResearch.maxCandidatesPerSource must be an integer > 0');
    }
  }
  if (typed.linearTeamId !== undefined && !isNonEmptyString(typed.linearTeamId)) {
    throw new Error('crossRepoResearch.linearTeamId must be a non-empty string when set');
  }
  if (typed.maps === undefined) return;
  if (typeof typed.maps !== 'object' || typed.maps === null || Array.isArray(typed.maps)) {
    throw new Error('crossRepoResearch.maps must be an object keyed by target repo URL');
  }
  const entries = Object.entries(typed.maps);
  if (entries.length > 0 && !isNonEmptyString(typed.linearTeamId)) {
    throw new Error('crossRepoResearch.linearTeamId is required when crossRepoResearch.maps is non-empty');
  }
  for (const [targetUrl, sources] of entries) {
    if (!isGitUrl(targetUrl)) {
      throw new Error(`crossRepoResearch.maps key must be a git URL; got ${JSON.stringify(targetUrl)}`);
    }
    if (!Array.isArray(sources)) {
      throw new Error(`crossRepoResearch.maps[${JSON.stringify(targetUrl)}] must be an array`);
    }
    sources.forEach((source, index) => {
      validateCrossRepoResearchSource(source, `crossRepoResearch.maps[${JSON.stringify(targetUrl)}][${index}]`);
    });
  }
}

/** Normalize a source entry to `{ repoUrl, lookbackDays }` with defaults applied. */
export function normalizeCrossRepoResearchSource(entry: string | CrossRepoResearchSource): Required<CrossRepoResearchSource> {
  if (typeof entry === 'string') {
    return { repoUrl: entry.trim(), lookbackDays: DEFAULT_CROSS_REPO_RESEARCH_LOOKBACK_DAYS };
  }
  return {
    repoUrl: entry.repoUrl.trim(),
    lookbackDays: entry.lookbackDays ?? DEFAULT_CROSS_REPO_RESEARCH_LOOKBACK_DAYS,
  };
}


function validateMergifyQueueResearchSource(entry: unknown, path: string): void {
  if (typeof entry === 'string') {
    if (!isGitUrl(entry)) {
      throw new Error(`${path} must be a git URL string; got ${JSON.stringify(entry)}`);
    }
    return;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${path} must be a git URL string or { repoUrl, lookbackDays? }`);
  }
  const source = entry as MergifyQueueResearchSource;
  if (!isNonEmptyString(source.repoUrl) || !isGitUrl(source.repoUrl)) {
    throw new Error(`${path}.repoUrl must be a git URL string`);
  }
  if (source.lookbackDays !== undefined) {
    if (typeof source.lookbackDays !== 'number' || !Number.isInteger(source.lookbackDays) || source.lookbackDays <= 0) {
      throw new Error(`${path}.lookbackDays must be an integer > 0`);
    }
  }
}

function validateMergifyQueueResearchConfig(config: InvokerConfig): void {
  const mergifyQueueResearch = config.mergifyQueueResearch;
  if (mergifyQueueResearch === undefined) return;
  if (typeof mergifyQueueResearch !== 'object' || mergifyQueueResearch === null || Array.isArray(mergifyQueueResearch)) {
    throw new Error('mergifyQueueResearch must be an object');
  }
  const typed = mergifyQueueResearch as MergifyQueueResearchConfig;
  if (typed.intervalDays !== undefined) {
    if (typeof typed.intervalDays !== 'number' || !Number.isInteger(typed.intervalDays) || typed.intervalDays <= 0) {
      throw new Error('mergifyQueueResearch.intervalDays must be an integer > 0');
    }
  }
  if (typed.maxCandidatesPerSource !== undefined) {
    if (
      typeof typed.maxCandidatesPerSource !== 'number'
      || !Number.isInteger(typed.maxCandidatesPerSource)
      || typed.maxCandidatesPerSource <= 0
    ) {
      throw new Error('mergifyQueueResearch.maxCandidatesPerSource must be an integer > 0');
    }
  }
  if (typed.linearTeamId !== undefined && !isNonEmptyString(typed.linearTeamId)) {
    throw new Error('mergifyQueueResearch.linearTeamId must be a non-empty string when set');
  }
  if (typed.maps === undefined) return;
  if (typeof typed.maps !== 'object' || typed.maps === null || Array.isArray(typed.maps)) {
    throw new Error('mergifyQueueResearch.maps must be an object keyed by target repo URL');
  }
  const entries = Object.entries(typed.maps);
  if (entries.length > 0 && !isNonEmptyString(typed.linearTeamId)) {
    throw new Error('mergifyQueueResearch.linearTeamId is required when mergifyQueueResearch.maps is non-empty');
  }
  for (const [targetUrl, sources] of entries) {
    if (!isGitUrl(targetUrl)) {
      throw new Error(`mergifyQueueResearch.maps key must be a git URL; got ${JSON.stringify(targetUrl)}`);
    }
    if (!Array.isArray(sources)) {
      throw new Error(`mergifyQueueResearch.maps[${JSON.stringify(targetUrl)}] must be an array`);
    }
    sources.forEach((source, index) => {
      validateMergifyQueueResearchSource(source, `mergifyQueueResearch.maps[${JSON.stringify(targetUrl)}][${index}]`);
    });
  }
}

/** Normalize a Mergify queue research source entry with defaults applied. */
export function normalizeMergifyQueueResearchSource(
  entry: string | MergifyQueueResearchSource,
): Required<MergifyQueueResearchSource> {
  if (typeof entry === 'string') {
    return { repoUrl: entry.trim(), lookbackDays: DEFAULT_MERGIFY_QUEUE_RESEARCH_LOOKBACK_DAYS };
  }
  return {
    repoUrl: entry.repoUrl.trim(),
    lookbackDays: entry.lookbackDays ?? DEFAULT_MERGIFY_QUEUE_RESEARCH_LOOKBACK_DAYS,
  };
}

export function validateInvokerConfig(config: InvokerConfig): InvokerConfig {
  const nestedExecutionAgent = config.defaultExecution?.executionAgent;
  const hasNestedExecutionAgent = typeof nestedExecutionAgent === 'string' && nestedExecutionAgent.trim().length > 0;
  if (config.defaultExecution?.executionModel !== undefined && !hasNestedExecutionAgent) {
    throw new Error('defaultExecution.executionModel requires defaultExecution.executionAgent');
  }

  const flatExecutionAgent = config.defaultExecutionAgent;
  const hasFlatExecutionAgent = typeof flatExecutionAgent === 'string' && flatExecutionAgent.trim().length > 0;
  if (config.defaultExecutionModel !== undefined && !hasFlatExecutionAgent) {
    throw new Error('defaultExecutionModel requires defaultExecutionAgent');
  }

  if (config.enabledExecutionAgents !== undefined) {
    if (!Array.isArray(config.enabledExecutionAgents)) {
      throw new Error('enabledExecutionAgents must be an array of agent names');
    }
    for (const entry of config.enabledExecutionAgents) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new Error('enabledExecutionAgents entries must be non-empty strings');
      }
    }
  }

  validateConfiguredModel(config.defaultExecution?.executionAgent, config.defaultExecution?.executionModel);
  validateConfiguredModel(config.defaultExecutionAgent, config.defaultExecutionModel);
  validatePrMaintenanceTargetRepos(config);
  validateE2eAutoFixTargetRepos(config);
  validateCrossRepoResearchConfig(config);
  validateMergifyQueueResearchConfig(config);
  return config;
}
