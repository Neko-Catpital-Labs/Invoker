import { parseForgeProject } from '@invoker/contracts';

const GIT_URL_PATTERN =
  /(?:git@[\w.-]+:[\w./-]+(?:\.git)?|https?:\/\/[\w.-]+\/[\w./-]+(?:\.git)?)/;

export function extractRepoUrlFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = GIT_URL_PATTERN.exec(text);
  if (!match) return undefined;
  const candidate = match[0];
  if (parseForgeProject(candidate)) return candidate;
  if (/\.git$/i.test(candidate) || /^git@/i.test(candidate)) return candidate;
  return undefined;
}

export function resolveChannelRepoUrl(topic: string | undefined, purpose: string | undefined): string | undefined {
  return extractRepoUrlFromText(topic) ?? extractRepoUrlFromText(purpose);
}
