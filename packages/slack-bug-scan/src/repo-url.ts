import { parseForgeProject } from '@invoker/contracts';

const GIT_URL_PATTERN =
  /(?:git@[\w.-]+:[\w./-]+(?:\.git)?|https?:\/\/[\w.-]+\/[\w./-]+(?:\.git)?)/;

function forgeRepoUrl(candidate: string): string | undefined {
  const project = parseForgeProject(candidate);
  if (!project) return undefined;
  if (!project.reviewId && !project.jobId && !project.runId && !project.pipelineId) return candidate;

  const origin = /^(https?:\/\/[^/]+)/i.exec(candidate)?.[0];
  if (origin) return `${origin}/${project.projectPath}`;
  return `git@${project.host}:${project.projectPath}.git`;
}

export function extractRepoUrlFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = GIT_URL_PATTERN.exec(text);
  if (!match) return undefined;
  const candidate = match[0];
  const forgeUrl = forgeRepoUrl(candidate);
  if (forgeUrl) return forgeUrl;
  const githubIssue = /^(https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+)\/issues\/\d+(?:\/.*)?$/i.exec(candidate);
  if (githubIssue) return githubIssue[1];
  if (/\.git$/i.test(candidate) || /^git@/i.test(candidate)) return candidate;
  return undefined;
}

export function resolveChannelRepoUrl(topic: string | undefined, purpose: string | undefined): string | undefined {
  return extractRepoUrlFromText(topic) ?? extractRepoUrlFromText(purpose);
}
