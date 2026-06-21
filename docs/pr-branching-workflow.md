# PR Branching Workflow (Origin Only)

Default workflow:

- Use `origin` as the only supported git remote for branch/base/PR operations.
- Create branches from `origin/<baseBranch>`.
- Publish branches to `origin`.
- Open PRs for the same `origin` repository (unless explicit env override is set).

## Invoker Plan Override

Invoker plans may optionally set `intermediateRepoUrl`:

```yaml
repoUrl: https://github.com/Neko-Catpital-Labs/Invoker
intermediateRepoUrl: https://github.com/your-org/invoker-intermediate
```

- Non-merge task branches (including reconciliation/rebase helper branches) are pushed to `intermediateRepoUrl`.
- Merge-gate/final publish and PR creation continue to use `origin` from `repoUrl`.
- If `intermediateRepoUrl` is omitted, all branch pushes remain `origin`-only.

## Rules

- Keep branch base and publish target on `origin`.
- Create PR branches from `origin/<baseBranch>`.
- Push branches to `origin`.
- Open PRs for the same `origin` repository.
- In any temp worktree or temp clone used for stack work, make sure `origin` points at GitHub, not a local filesystem clone.

## Clean PR Flow

1. Create branch from base remote:

```bash
bash scripts/create-clean-pr-branch.sh --base-remote origin --publish-remote origin --base-ref master pr/<name> [commit ...]
```

2. Push branch:

```bash
git push -u origin pr/<name>
```

3. Start from the canonical body template and validate it:

```bash
cp scripts/pr-body-template.md /tmp/my-pr.md
$EDITOR /tmp/my-pr.md
node scripts/validate-pr-body.mjs --body-file /tmp/my-pr.md
```

4. Create/update PR:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file /tmp/my-pr.md
```


## Mergify stack workflow

If the target repo is Invoker itself (`EdbertChan/Invoker` or `Neko-Catpital-Labs/Invoker`):

- use `origin` as the base remote, publish remote, and PR target repo
- if the finished work is too large for one PR, use `skills/review-compression/SKILL.md` first to define the slice order before creating any PR branches
- create the first slice with `bash scripts/create-clean-pr-branch.sh --base-remote origin --publish-remote origin --base-ref <base> pr/<slice-1> <commit ...>`
- after pushing `pr/<slice-1>`, restore its local target with `git branch --set-upstream-to=origin/<base> pr/<slice-1>`
- after pushing `pr/<slice-1>`, create `pr/<slice-2>` and later slices with the same helper but `--base-ref pr/<previous-slice>`
- after pushing each later slice, restore its local target with `git branch --set-upstream-to=origin/pr/<previous-slice> pr/<slice-N>`
- direct `git push` on a Mergify-managed stack branch is expected to fail because the hook blocks it
- publish stack branches with `mergify stack push`
- after `mergify stack push`, repair PR titles or bodies as a second step by rerunning `create-pr` in update mode on the created stack branch
- do not recreate an existing stack PR by cherry-picking into a fresh `land/*` or ad hoc branch, because GitHub and Mergify will open a new PR instead of updating the existing one

The `git push -u` step points a local stack branch at itself. Reset the local target back to the intended base branch before `mergify stack push`, or Mergify will reject the stack as self-targeting.

Large diff to stack sequence:

1. review-compress the work into ordered slices
2. create and push `pr/<slice-1>` from `origin/<base>`
3. run `git branch --set-upstream-to=origin/<base> pr/<slice-1>`
4. create and push each later `pr/<slice-N>` from `origin/pr/<slice-(N-1)>`
5. run `git branch --set-upstream-to=origin/pr/<slice-(N-1)> pr/<slice-N>` for each later slice
6. run `mergify stack push` only after the branch stack exists
7. rerun `create-pr` in update mode on each stack branch to patch the PR bodies

Stack PR body update example:

```bash
mergify stack push
git switch pr/<slice-name>
node scripts/create-pr.mjs --title "<title>" --base <base> --body-file /tmp/my-pr.md --update-existing
```

## Temporary policy

- Upstream-specific routing is intentionally removed until remote selection is reintroduced via explicit plan config.
- Existing workflows should use `origin` for base resolution and branch publication.
