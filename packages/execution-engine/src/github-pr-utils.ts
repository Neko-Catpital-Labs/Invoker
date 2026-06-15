export const GITHUB_TARGET_REPO_ENV = 'INVOKER_GITHUB_TARGET_REPO';

export type GitHubPullListItem = {
  url: string;
  number: number;
};

export function isGitHubApiRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /GraphQL:\s*API rate limit/i.test(message)
    || /API rate limit already exceeded/i.test(message)
    || /secondary rate limit/i.test(message);
}

export function parseGitHubRepoNwo(url: string): string | undefined {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

export function githubRepoOwner(repoNwo: string): string {
  return repoNwo.split('/')[0] ?? '';
}

export function parseGitHubPullListOutput(output: string): GitHubPullListItem[] {
  const parsed = JSON.parse(output || '[]') as Array<{
    url?: string;
    html_url?: string;
    number?: number;
  }>;
  return parsed.flatMap((item) => {
    const url = item.url ?? item.html_url;
    if (!url || typeof item.number !== 'number') return [];
    return [{ url, number: item.number }];
  });
}
