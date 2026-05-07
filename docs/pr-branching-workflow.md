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

## Temporary policy

- Upstream-specific routing is intentionally removed until remote selection is reintroduced via explicit plan config.
- Existing workflows should use `origin` for base resolution and branch publication.
