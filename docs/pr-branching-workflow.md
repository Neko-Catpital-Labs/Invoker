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

## Publication Strategy

The execution engine dispatches review creation and approval polling through a **publication strategy router** (`packages/execution-engine/src/publication-strategy-router.ts`). The workflow's `publicationStrategy` field selects the provider.

| `publicationStrategy` | Provider | PR creation behavior |
|---|---|---|
| `github_pr` (default) | `GitHubMergeGateProvider` | Creates a standard GitHub PR against `origin`, polls review approval |
| `mergify_stack` (opt-in) | `MergifyStackProvider` | Runs `mergify stack push` from the gate workspace, resolves the stacked PR |

Both strategies operate within the `origin`-only branching policy above. `mergify_stack` publications push stack branches to `origin` and create PRs in the same repository.

**When to use `mergify_stack`:** Only when the target repo uses Mergify Stacks (e.g. Invoker-on-Invoker dogfooding). All other repos should omit `publicationStrategy` to use the `github_pr` default.

**Known `mergify_stack` limitations** (validated by lifecycle PoC in `docs/mergify-stack-lifecycle-poc.md`):
- Mid-stack rewrites recreate affected PRs with new numbers; review comments are lost.
- Re-push after mid-stack cancel fails with HTTP 422; adapter must close downstream PRs before re-pushing.
- PR number instability requires refreshing PR mappings after every force-push.

## Temporary policy

- Upstream-specific routing is intentionally removed until remote selection is reintroduced via explicit plan config.
- Existing workflows should use `origin` for base resolution and branch publication.
