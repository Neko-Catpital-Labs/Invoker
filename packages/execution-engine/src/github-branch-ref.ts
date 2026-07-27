/**
 * GitHub `gh` pull-request commands and the REST API expect the short branch name
 * on the repository (e.g. `fix/foo`), not a remote-tracking ref (`origin/fix/foo`)
 * or a fully qualified ref (`refs/heads/fix/foo`). Passing `origin/...` as `base`
 * yields HTTP 422 Validation Failed from the pulls API.
 */
function sortedRemoteNames(remoteNames: readonly string[]): string[] {
  const unique = [...new Set(remoteNames.map((name) => name.trim()).filter(Boolean))];
  return unique.sort((left, right) => right.length - left.length);
}

function stripKnownRemotePrefix(ref: string, remoteNames: readonly string[]): string | undefined {
  for (const remoteName of sortedRemoteNames(remoteNames)) {
    const prefix = `${remoteName}/`;
    if (ref.startsWith(prefix) && ref.length > prefix.length) {
      return ref.slice(prefix.length);
    }
  }
  return undefined;
}

export function normalizeBranchForGithubCli(ref: string, remoteNames: readonly string[] = ['origin']): string {
  let s = ref.trim();
  if (!s) return s;
  if (s.startsWith('refs/heads/')) {
    return s.slice('refs/heads/'.length);
  }
  if (s.startsWith('refs/remotes/')) {
    const stripped = stripKnownRemotePrefix(s.slice('refs/remotes/'.length), remoteNames);
    if (stripped) return stripped;
    const rest = s.slice('refs/remotes/'.length);
    const i = rest.indexOf('/');
    return i === -1 ? rest : rest.slice(i + 1);
  }
  return stripKnownRemotePrefix(s, remoteNames) ?? s;
}
