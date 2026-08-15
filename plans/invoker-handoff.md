# Repair UI Vitest native build prerequisites

## Diagnosis

PR #9185's UI Vitest job fails before Vitest starts. `node-pty@1.1.0` has no
Linux x64 prebuild on the affected self-hosted runner, so its install falls
back to `node-gyp`. Python is found, but `node-gyp` exits with
`Error: not found: make`. The UI Vitest workflow currently installs only
`libatomic1`, and the existing workflow-policy test does not require the
native build toolchain.

The same failure appears on PR #9196, so this is a shared CI infrastructure
regression rather than a defect in PR #9185's PR Authoring Guardrails change.
It must ship independently instead of expanding #9185's review claim.

## Implementation slice

Review claim: UI Vitest installs the native build tools required when
`node-pty` falls back to `node-gyp`, and a focused workflow-policy assertion
prevents their removal.

Review lane: policy

Safety invariant: PR #9185 remains untouched and scoped to PR Authoring
Guardrails; UI Vitest's runner label, Node version, dependency command, test
command, and every other CI job remain unchanged. Only UI Vitest's existing
system-dependency step and its directly affected policy assertion change.

Slice rationale: The workflow prerequisite and its exact regression assertion
form one CI-policy unit. They are separate from #9185's hosted-capacity claim.

Architectural effect: UI Vitest runner preparation explicitly owns the native
compiler prerequisites needed by dependency installation. Product control
flow, public interfaces, and application behavior do not change.

Alternative considerations: Re-running cannot install a missing executable.
Changing Node, changing `node-pty`, suppressing lifecycle scripts, or moving
UI Vitest to another runner would broaden the repair and obscure the missing
runner prerequisite.

Non-goals: No changes to PR #9185, product/UI behavior, dependency versions,
runner assignment, Node version, or unrelated CI jobs.

## Repro and acceptance

1. Extend `scripts/test-ci-workflow-merge-queue-policy.mjs` so it requires
   `libatomic1`, `make`, and `g++` in UI Vitest's pre-Node system-dependency
   step. Before the workflow edit, the assertion must fail because `make` and
   `g++` are absent.
2. Update `.github/workflows/ci.yml` to install those packages in the existing
   UI Vitest system-dependency step.
3. Run `node scripts/test-ci-workflow-merge-queue-policy.mjs`; it must exit 0.
4. Confirm UI Vitest still uses `Runner_Vitest`, Node 26,
   `pnpm install --frozen-lockfile`, and `pnpm --filter @invoker/ui test`.

Repro waiver: the missing executable is external runner state and cannot be
removed locally. GitHub job 94987863334 directly records the fallback and
failure: `Rebuilding because .../prebuilds/linux-x64 does not exist`, followed
by `gyp ERR! stack Error: not found: make`.
