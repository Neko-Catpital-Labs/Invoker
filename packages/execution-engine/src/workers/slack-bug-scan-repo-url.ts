const GIT_URL_PATTERN = /https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+(?:\.git)?/g;

export function normalizeAllowedRepoHosts(allowedHosts: readonly string[]): string[] {
  return [...new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export function isAllowedRepoUrl(repoUrl: string, allowedHosts: readonly string[]): boolean {
  const normalizedAllowedHosts = normalizeAllowedRepoHosts(allowedHosts);
  if (normalizedAllowedHosts.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return false;
  }

  return parsed.protocol === 'https:' && normalizedAllowedHosts.includes(parsed.hostname.toLowerCase());
}

export function extractRepoUrlFromText(text: string | undefined, allowedHosts: readonly string[]): string | undefined {
  if (!text) return undefined;
  for (const match of text.matchAll(GIT_URL_PATTERN)) {
    const candidate = match[0];
    if (isAllowedRepoUrl(candidate, allowedHosts)) return candidate;
  }
  return undefined;
}

export function resolveChannelRepoUrl(
  topic: string | undefined,
  purpose: string | undefined,
  allowedHosts: readonly string[],
): string | undefined {
  return extractRepoUrlFromText(topic, allowedHosts) ?? extractRepoUrlFromText(purpose, allowedHosts);
}
