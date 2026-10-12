import { parseForgeProject } from '@invoker/contracts';

const GIT_URL_PATTERN =
  /(?:git@[\w.-]+:[\w./-]+(?:\.git)?|https?:\/\/[\w.-]+\/[\w./-]+(?:\.git)?)/;

const GITHUB_ISSUE_URL_PATTERN =
  /^(https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+)\/issues\/\d+(?:\/.*)?$/i;

export function extractRepoUrlFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = GIT_URL_PATTERN.exec(text);
  if (!match) return undefined;
  const candidate = match[0];
  const project = parseForgeProject(candidate);
  if (project) {
    if (project.reviewId || project.jobId || project.pipelineId || project.runId) {
      const origin = /^(https?:\/\/[^/]+)/i.exec(candidate)?.[0];
      return origin ? `${origin}/${project.projectPath}` : `git@${project.host}:${project.projectPath}.git`;
    }
    return candidate;
  }
  const githubIssue = GITHUB_ISSUE_URL_PATTERN.exec(candidate);
  if (githubIssue) return githubIssue[1];
  if (/\.git$/i.test(candidate) || /^git@/i.test(candidate)) return candidate;
  return undefined;
}

export function resolveChannelRepoUrl(topic: string | undefined, purpose: string | undefined): string | undefined {
  return extractRepoUrlFromText(topic) ?? extractRepoUrlFromText(purpose);
}
