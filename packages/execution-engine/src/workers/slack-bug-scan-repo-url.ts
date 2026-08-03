const GIT_URL_PATTERN = /(?:git@[\w.-]+:[\w.-]+\/[\w.-]+(?:\.git)?|https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+(?:\.git)?)/;

export function extractRepoUrlFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = GIT_URL_PATTERN.exec(text);
  return match ? match[0] : undefined;
}

export function resolveChannelRepoUrl(topic: string | undefined, purpose: string | undefined): string | undefined {
  return extractRepoUrlFromText(topic) ?? extractRepoUrlFromText(purpose);
}
