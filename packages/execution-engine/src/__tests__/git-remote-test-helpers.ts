import { execFileSync } from 'node:child_process';

const TEST_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: TEST_GIT_ENV }).trim();
}

export function advanceRemoteBranch(remoteRepo: string, commits: number, branch = 'master'): string {
  let head = git(['rev-parse', `refs/heads/${branch}`], remoteRepo);
  const tree = git(['rev-parse', `${head}^{tree}`], remoteRepo);

  for (let i = 1; i <= commits; i++) {
    head = git(['commit-tree', tree, '-p', head, '-m', `remote advance ${i}`], remoteRepo);
  }

  git(['update-ref', `refs/heads/${branch}`, head], remoteRepo);
  return head;
}
