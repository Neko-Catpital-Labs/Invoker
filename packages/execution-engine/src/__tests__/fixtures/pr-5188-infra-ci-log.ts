/** Log excerpt from PR #5188 checkout failure on invoker-do2-gha-ssh. */
export const PR_5188_INFRA_LOG = `
##[group]Run actions/checkout@v4
##[error]error: could not delete reference refs/heads/experiment/e2e-g336-ssh-pr: Unable to create '/home/invoker/actions-runner-do2-ssh/_work/Invoker/Invoker/.git/packed-refs.lock': Permission denied
##[warning]Unable to prepare the existing repository. The repository will be recreated instead.
##[error]File was unable to be removed Error: EACCES: permission denied, rmdir '/home/invoker/actions-runner-do2-ssh/_work/Invoker/Invoker/.claude/plugins'
`;
