# PR Branching Workflow (Upstream First)

Default workflow:

- Clone the canonical repository directly (for Invoker: `https://github.com/Neko-Catpital-Labs/Invoker`).
- Create branches from your canonical base remote.
- Publish branches to `origin` (or another explicit publish remote).
- Open PRs against `Neko-Catpital-Labs/Invoker`.

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

- Do not rely on automatic fork-sync scripts before submission.
- Keep base and publish remotes explicit when they differ.
- Create PR branches from `<baseRemote>/<baseBranch>`.
- Push branches to `<publishRemote>` and target the canonical repository base branch in PRs.

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

## Migrating Existing Fork-First Clones

- Stop using `scripts/sync-fork-upstream.sh` for branch freshness.
- Set your base remote explicitly when creating branches.
- If your repo keeps a separate publish remote, pass it via `--publish-remote`.
