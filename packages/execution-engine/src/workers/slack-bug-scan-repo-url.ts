const HTTPS_REPO_URL_PATTERN = /https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+(?:\.git)?/g;

function normalizeAllowedHosts(allowedHosts: readonly string[]): ReadonlySet<string> {
  return new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0));
}

function isAllowedHttpsRepoUrl(candidate: string, allowedHosts: ReadonlySet<string>): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  return url.protocol === 'https:' && allowedHosts.has(url.hostname.toLowerCase());
}

export function extractRepoUrlFromText(
  text: string | undefined,
  allowedHosts: readonly string[],
): string | undefined {
  if (!text) return undefined;
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  for (const match of text.matchAll(HTTPS_REPO_URL_PATTERN)) {
    const candidate = match[0];
    if (isAllowedHttpsRepoUrl(candidate, normalizedAllowedHosts)) return candidate;
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
