# PR Branching Workflow (Fork + Upstream)

Use this workflow to keep pull requests clean when `origin/master` contains fork-only commits.

## Rules

- Never push working branches to `upstream`.
- Push branches to `origin` only.
- Create PR branches from `upstream/master`, not `origin/master`.
- Open PRs targeting `upstream` repository `master`.

## Clean PR flow

1. Create branch from upstream:

```bash
bash scripts/create-clean-pr-branch.sh pr/<name> [commit ...]
```

2. Push to fork:

```bash
git push -u origin pr/<name>
```

3. Create/update PR:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file <file>
```

## Guardrail behavior

`create-pr.mjs` hard-fails when the current branch contains commits from
`upstream/master..origin/master`.

When this happens, create a clean branch from `upstream/master` and cherry-pick only intended commits.
