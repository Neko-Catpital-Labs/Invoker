# INV-86 Experiment Brief: Headless Owner Delegation and Bundled Skills

Date: 2026-05-25

## Goal

Establish deterministic proof for INV-86 so the architecture choice is evidence-backed and reviewable.

Files under test:

- `packages/app/src/main.ts`
- `packages/app/src/headless-client.ts`
- `packages/app/src/bundled-skills.ts`

## Selected Approach

Use a shared owner architecture for mutating headless commands, with a thin headless client that discovers, delegates to, or bootstraps an owner process before falling back to the Electron headless runtime for non-mutating or explicit standalone commands.

Concrete file evidence:

- `packages/app/src/main.ts:204` detects headless/install-skills mode at the Electron entrypoint.
- `packages/app/src/main.ts:416` and `packages/app/src/main.ts:424` wire bundled skill status/install functions into the runtime.
- `packages/app/src/main.ts:814` passes `getBundledSkillsStatus` and `installBundledSkills` through `HeadlessDeps`.
- `packages/app/src/main.ts:976` starts delegated request handling when the process is a standalone owner.
- `packages/app/src/main.ts:1129`, `packages/app/src/main.ts:1137`, `packages/app/src/main.ts:1154`, and `packages/app/src/main.ts:1168` register owner ping/query/resume/exec request handlers.
- `packages/app/src/headless-client.ts:77` through `packages/app/src/headless-client.ts:83` define bounded delegation/bootstrap timeouts.
- `packages/app/src/headless-client.ts:317` implements the discover, fallback, bootstrap, delegate policy.
- `packages/app/src/headless-client.ts:432` routes read-only, mutating, standalone, and internal owner commands through the client decision tree.
- `packages/app/src/bundled-skills.ts:39` lists bundled skills deterministically.
- `packages/app/src/bundled-skills.ts:46` hashes the skill tree with sorted traversal.
- `packages/app/src/bundled-skills.ts:155` computes install status from source hash, manifest, and target paths.
- `packages/app/src/bundled-skills.ts:188` installs managed skill copies and writes the manifest.

## Competing Design

Alternative: run every headless invocation as an independent writable Electron process with inline skill installation logic in `main.ts`.

Comparison:

- Determinism: selected approach has a single mutation owner and persisted mutation coordinator paths; independent writable processes would race on DB ownership and task mutation ordering.
- Reviewability: selected approach keeps delegation policy in `headless-client.ts` and skill packaging in `bundled-skills.ts`; inline logic would mix CLI routing, owner lifecycle, and filesystem install state in one large entrypoint.
- Recovery behavior: selected approach has bounded owner discovery, retry, and bootstrap phases; independent processes would need duplicate lock and recovery logic per command.
- Skill reproducibility: selected approach uses sorted skill names and sorted directory hashing; ad hoc inline copy logic would be harder to verify with a small deterministic probe.

Verdict: select the shared owner plus deterministic bundled skill module. It gives stronger mutation serialization and smaller, reviewable proof surfaces.

## Deterministic Proof Commands

### 1. Static architecture anchor probe

Command:

```sh
node - <<'NODE'
const fs = require('fs');
const checks = [
  ['packages/app/src/main.ts', [
    'const isHeadless = headlessIndex !== -1 || directInstallSkills;',
    'getBundledSkillsStatus,',
    'installBundledSkills: installPackagedSkills,',
    "messageBus.onRequest('headless.owner-ping'",
    "messageBus.onRequest('headless.exec'",
    'await runHeadless(cliArgs, headlessDeps);'
  ]],
  ['packages/app/src/headless-client.ts', [
    'const POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS = 3;',
    'function parseArgs(argv: string[]):',
    'async function resolveOwnerAndDelegate(',
    'return deps.runElectronHeadless(argv);'
  ]],
  ['packages/app/src/bundled-skills.ts', [
    "const MANAGED_PREFIX = 'invoker-';",
    'function hashDirectory(root: string): string',
    'const entries = readdirSync(dir, { withFileTypes: true }).sort',
    'export function resolveBundledSkillsStatus',
    'export function installBundledSkills'
  ]]
];
let ok = true;
for (const [file, needles] of checks) {
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of needles) {
    const found = text.includes(needle);
    console.log(`${found ? 'PASS' : 'FAIL'} ${file} :: ${needle}`);
    ok &&= found;
  }
}
process.exit(ok ? 0 : 1);
NODE
```

Expected output threshold:

- Exit code must be `0`.
- Exactly 15 `PASS` lines.
- Zero `FAIL` lines.

Observed output:

```text
PASS packages/app/src/main.ts :: const isHeadless = headlessIndex !== -1 || directInstallSkills;
PASS packages/app/src/main.ts :: getBundledSkillsStatus,
PASS packages/app/src/main.ts :: installBundledSkills: installPackagedSkills,
PASS packages/app/src/main.ts :: messageBus.onRequest('headless.owner-ping'
PASS packages/app/src/main.ts :: messageBus.onRequest('headless.exec'
PASS packages/app/src/main.ts :: await runHeadless(cliArgs, headlessDeps);
PASS packages/app/src/headless-client.ts :: const POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS = 3;
PASS packages/app/src/headless-client.ts :: function parseArgs(argv: string[]):
PASS packages/app/src/headless-client.ts :: async function resolveOwnerAndDelegate(
PASS packages/app/src/headless-client.ts :: return deps.runElectronHeadless(argv);
PASS packages/app/src/bundled-skills.ts :: const MANAGED_PREFIX = 'invoker-';
PASS packages/app/src/bundled-skills.ts :: function hashDirectory(root: string): string
PASS packages/app/src/bundled-skills.ts :: const entries = readdirSync(dir, { withFileTypes: true }).sort
PASS packages/app/src/bundled-skills.ts :: export function resolveBundledSkillsStatus
PASS packages/app/src/bundled-skills.ts :: export function installBundledSkills
```

Verdict: pass. The selected design surfaces are present in the concrete files under test.

### 2. Focused behavior tests

Command:

```sh
pnpm --filter @invoker/app exec vitest run src/__tests__/bundled-skills.test.ts src/__tests__/headless-client.test.ts
```

Expected output threshold:

- Exit code must be `0`.
- Test files must report `2 passed`.
- Tests must report `20 passed`.
- `headless-client` timeout/retry tests may be slow, but must complete without skipped or failed tests.

Observed output:

```text
Test Files  2 passed (2)
Tests  20 passed (20)
Duration  69.83s
```

Relevant covered behavior:

- `bundled-skills.test.ts` proves bundled skill status/install behavior is isolated and testable.
- `headless-client.test.ts` proves no-track delegation timeout handling, bootstrap retry after owner loss, queue query refresh, UI performance query error behavior, and read-only/mutating route separation.

Verdict: pass. The selected approach has deterministic behavior coverage for the review-critical delegation and skills-install surfaces.

## Acceptance Thresholds

INV-86 is accepted when all of these hold:

- Static architecture probe exits `0` with 15/15 anchors passing.
- Focused behavior tests exit `0` with 2/2 test files and 20/20 tests passing.
- The brief names the concrete files under test and cites concrete source locations.
- At least one competing design is compared against the selected approach.

Current result: accepted.
