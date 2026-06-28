import {
  detectDefaultBranchRemote,
  requireRemoteBranch,
} from '@invoker/workflow-core';
import { getRepoTargetBranch, loadConfig, setRepoTargetBranch } from './config.js';

export function resolveRepoTargetBranch(repoUrl: string): string {
  const trimmedRepoUrl = repoUrl.trim();
  if (trimmedRepoUrl === '') throw new Error('Repo URL is required.');

  const config = loadConfig();
  const configuredBranch = getRepoTargetBranch(config, trimmedRepoUrl) ?? config.defaultBranch?.trim();
  if (configuredBranch && configuredBranch !== '') {
    return requireRemoteBranch(trimmedRepoUrl, configuredBranch);
  }

  const detectedBranch = detectDefaultBranchRemote(trimmedRepoUrl);
  if (detectedBranch) return detectedBranch;
  throw new Error(`Unable to resolve default branch for repo ${trimmedRepoUrl}. Set a repo target branch or make the remote HEAD readable.`);
}

export function saveRepoTargetBranch(repoUrl: string, branch: string): string {
  const trimmedRepoUrl = repoUrl.trim();
  const targetBranch = requireRemoteBranch(trimmedRepoUrl, branch);
  setRepoTargetBranch(trimmedRepoUrl, targetBranch);
  return targetBranch;
}
