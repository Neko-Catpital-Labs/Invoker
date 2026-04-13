function unquoteShellToken(token: string): string {
  if (
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('"') && token.endsWith('"'))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function extractRepoBasename(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  const normalized = repoUrl.replace(/\/+$/, '');
  const tail = normalized.split(/[:/]/).pop();
  if (!tail) return undefined;
  return tail.replace(/\.git$/i, '') || undefined;
}

export function rewriteLegacyAbsoluteRepoCd(command: string, repoUrl?: string): string {
  const match = command.match(/^\s*cd\s+((?:'[^']*'|"[^"]*"|[^\s&;]+))\s*&&\s*([\s\S]+)$/);
  if (!match) return command;

  const repoBasename = extractRepoBasename(repoUrl);
  if (!repoBasename) return command;

  const target = unquoteShellToken(match[1]).replace(/\/+$/, '');
  const remainder = match[2];
  if (!target.startsWith('/') && !target.startsWith('~/')) return command;

  const marker = `/${repoBasename}`;
  const markerIndex = target.lastIndexOf(marker);
  if (markerIndex === -1) return command;

  const suffix = target.slice(markerIndex + marker.length).replace(/^\/+/, '');
  if (!suffix) return remainder;
  return `cd ${suffix} && ${remainder}`;
}
