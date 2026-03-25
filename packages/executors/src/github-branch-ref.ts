/**
 * GitHub `gh` pull-request commands and the REST API expect the short branch name
 * on the repository (e.g. `fix/foo`), not a remote-tracking ref (`origin/fix/foo`)
 * or a fully qualified ref (`refs/heads/fix/foo`). Passing `origin/...` as `base`
 * yields HTTP 422 Validation Failed from the pulls API.
 */
export function normalizeBranchForGithubCli(ref: string): string {
  let s = ref.trim();
  if (!s) return s;
  if (s.startsWith('refs/heads/')) {
    return s.slice('refs/heads/'.length);
  }
  if (s.startsWith('refs/remotes/')) {
    const rest = s.slice('refs/remotes/'.length);
    const i = rest.indexOf('/');
    return i === -1 ? rest : rest.slice(i + 1);
  }
  if (s.startsWith('origin/')) {
    return s.slice('origin/'.length);
  }
  if (s.startsWith('upstream/')) {
    return s.slice('upstream/'.length);
  }
  return s;
}
