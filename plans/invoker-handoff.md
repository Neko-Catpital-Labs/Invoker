# Repair UI Vitest native build prerequisites

## Diagnosis

PR #9185's UI Vitest job fails before Vitest starts. `node-pty@1.1.0` has no
Linux x64 prebuild on the affected runner, so its install falls back to
`node-gyp`. Python is found, but `node-gyp` exits with
`Error: not found: make`. The UI Vitest workflow installs only `libatomic1`,
and the existing workflow-policy test does not require the native toolchain.

The same failure recurred on current PR head `655661138` in job `94988993154`.
This is a shared UI Vitest runner-preparation defect, not a defect in PR #9185's
required-fast runner policy. It must ship independently instead of expanding
#9185's review claim.

## Implementation slice

Review claim: UI Vitest installs the native build tools required when
`node-pty` falls back to `node-gyp`, and a focused workflow-policy assertion
prevents their removal.

Review lane: policy

Safety invariant: PR #9185 remains untouched and scoped to required-fast runner
policy; UI Vitest's runner label, Node version, dependency command, test command,
and every other CI job remain unchanged. Only UI Vitest's existing
system-dependency step and its directly affected policy assertion change.

Slice rationale: The workflow prerequisite and its exact regression assertion
form one CI-policy unit. They are separate from #9185's hosted-capacity claim.

Architectural effect: UI Vitest runner preparation explicitly owns the native
compiler prerequisites needed by dependency installation. Product control
flow, public interfaces, and application behavior do not change.

Alternative considerations: Re-running cannot install a missing executable.
Changing Node, changing `node-pty`, suppressing lifecycle scripts, or moving UI
Vitest to another runner would broaden the repair and obscure the missing runner
prerequisite.

Non-goals: No changes to PR #9185, product/UI behavior, dependency versions,
runner assignment, Node version, or unrelated CI jobs.

## Repro and acceptance

The existing remote commit `83cb8cb82a62d7328c95e84d755d4a8f25205fd0`
contains the focused workflow repair and its regression assertion. Its patch
applies cleanly to PR #9185's current head, but must be landed independently on
current `master`.

1. Fetch and cherry-pick that exact repair commit onto current `master`.
2. Run `node scripts/test-ci-workflow-merge-queue-policy.mjs`; it must exit 0.
3. Confirm UI Vitest still uses `Runner_Vitest`, Node 26,
   `pnpm install --frozen-lockfile`, and `pnpm --filter @invoker/ui test`.

Repro waiver: the missing executable is external runner state and cannot be
removed locally. GitHub jobs `94987863334` and `94988993154` directly record
the fallback and failure: `Rebuilding because .../prebuilds/linux-x64 does not
exist`, followed by `gyp ERR! stack Error: not found: make`.
