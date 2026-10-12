import { parseForgeProject, type ForgeProject } from '@invoker/contracts';

const GIT_URL_PATTERN =
  /(?:git@[\w.-]+:[\w./-]+(?:\.git)?|https?:\/\/[\w.-]+\/[\w./-]+(?:\.git)?)/;
const GITHUB_ISSUE_URL_PATTERN =
  /^(https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+)\/issues\/\d+(?:\/.*)?$/i;

function hasResourceId(project: ForgeProject): boolean {
  return Boolean(project?.reviewId || project?.jobId || project?.pipelineId || project?.runId);
}

function rootUrlForForgeResource(candidate: string, project: ForgeProject): string {
  if (/^git@/i.test(candidate)) return `git@${project.host}:${project.projectPath}.git`;

  const parsed = new URL(candidate);
  return `${parsed.origin}/${project.projectPath}`;
}

export function extractRepoUrlFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = GIT_URL_PATTERN.exec(text);
  if (!match) return undefined;
  const candidate = match[0];
  const project = parseForgeProject(candidate);
  if (project) {
    return hasResourceId(project) ? rootUrlForForgeResource(candidate, project) : candidate;
  }
  const githubIssue = GITHUB_ISSUE_URL_PATTERN.exec(candidate);
  if (githubIssue) return githubIssue[1];
  if (/\.git$/i.test(candidate) || /^git@/i.test(candidate)) return candidate;
  return undefined;
}

export function resolveChannelRepoUrl(topic: string | undefined, purpose: string | undefined): string | undefined {
  return extractRepoUrlFromText(topic) ?? extractRepoUrlFromText(purpose);
}
