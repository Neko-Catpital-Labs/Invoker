# PR Branching Workflow (Parent Remote)

Use this workflow when your repo has both `origin` (your writable fork) and a read-only parent remote. The parent remote defaults to `upstream`, but any remote name can be used.

## Rules

- Never push working branches to the parent remote.
- Push branches to `origin` only.
- Create PR branches from `<parentRemote>/<baseBranch>`, not `origin/<baseBranch>`.
- Open PRs targeting the parent repository base branch.

## Clean PR Flow

1. Create branch from parent remote:

```bash
bash scripts/create-clean-pr-branch.sh --parent-remote upstream --base-ref master pr/<name> [commit ...]
```

2. Push to fork:

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

By default, tools in this workflow use `upstream` as the parent remote. Override it when your team uses a different remote name.
