# Test suite registry (`test:all`)

The orchestrator is **`scripts/run-all-tests.sh`**, invoked as **`pnpm run test:all`** from the repo root.

## Layout (add new suites here)

| Directory | When it runs |
|-----------|----------------|
| **`required/`** | Every `pnpm run test:all` (default CI surface) |
| **`optional/`** | `pnpm run test:all:extended` or `INVOKER_TEST_ALL_EXTENDED=1` |
| **`dangerous/`** | Same as extended **and** `INVOKER_TEST_ALL_DANGEROUS=1` (e.g. `pnpm run test:all:destructive`) — can touch real user paths / Docker |

## Naming

- Use **`NN-meaningful-name.sh`** (`10-`, `20-`, …) so lexicographic order matches run order.
- Files starting with **`_`** are ignored (placeholders or shared snippets).
- Each suite script must **`exit 0`** on success and **non-zero** on failure.
- Resolve repo root as:

  `ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"`  
  (three levels up from `required/foo.sh` → repo root)

## Environment (orchestrator)

| Variable | Effect |
|----------|--------|
| `INVOKER_TEST_ALL_EXTENDED=1` | Run `optional/` suites |
| `INVOKER_TEST_ALL_DANGEROUS=1` | Also run `dangerous/` (requires extended) |
| `INVOKER_TEST_ALL_FAIL_FAST=1` | Stop after the first failing suite |
| `INVOKER_TEST_ALL_RESUME=1` | Resume from saved per-suite state for the current mode |
| `INVOKER_TEST_ALL_FORCE_RERUN=1` | Ignore saved state and rerun every discovered suite |
| `INVOKER_TEST_ALL_STATE_FILE=/path/to/state.tsv` | Override the state file location |
| `INVOKER_TEST_ALL_JOBS=2` | Allow explicitly tagged parallel-safe suites to overlap |
| `INVOKER_WORKSPACE_TEST_CONCURRENCY=4` | Override local workspace test concurrency |
| `INVOKER_PLAYWRIGHT_WORKERS=2` | Override `packages/app` Playwright workers |
| `INVOKER_PLAYWRIGHT_SHARD=1/4` | Run the Playwright suite wrapper as a specific shard |
| `INVOKER_PLAYWRIGHT_SHARD_INDEX=1` + `INVOKER_PLAYWRIGHT_SHARD_TOTAL=4` | Alternate shard syntax for CI matrices |
| `INVOKER_PLAYWRIGHT_RUN_LABEL=ci-linux` | Prefix isolated Playwright artifact and bare-repo paths |
| `INVOKER_PLAYWRIGHT_ARGS='--grep \"visual proof\"'` | Forward simple extra args through the Playwright suite wrapper |
| `INVOKER_CHAOS_MODE=nightly` | Expand the chaos suite with repeated high-risk scenarios |
| `INVOKER_CHAOS_SEED=1234` | Deterministically shuffle chaos scenario order |
| `INVOKER_CHAOS_SCENARIO=owner-approve` | Run only matching chaos scenarios |
| `INVOKER_CHAOS_CASE_TIMEOUT_SECONDS=900` | Outer timeout applied to each chaos scenario |

## Resume and availability

- Suite state is tracked per mode: `required`, `extended`, or `dangerous`.
- `INVOKER_TEST_ALL_RESUME=1` skips only suites previously marked `passed` or `skipped-unavailable`.
- Failed suites rerun by default so the next pass still proves the fix.
- Environment-missing suites should be surfaced as `skipped-unavailable` when the runner can detect the missing prerequisite early. The Docker dangerous suite is the initial case.

## Sharding

- Long E2E wrappers should be split into thin suite shards so resume and later parallelism operate on smaller units.
- Current shards:
  - `required/20-e2e-dry-run.sh`: `case-1.*`
  - `required/21-e2e-dry-run-downstream.sh`: `case-2.*`
  - `required/22-e2e-dry-run-github.sh`: `case-4.*`
  - `optional/32-e2e-chaos.sh`: generated local + GUI-owner chaos matrix
  - `optional/33-e2e-chaos-overload.sh`: generated overload chaos suite for saturation and mixed-operation storms
  - `optional/30-e2e-ssh.sh`: `case-3.1` to `case-3.3`
  - `optional/31-e2e-ssh-merge.sh`: `case-3.4` to `case-3.6`

Do **not** add ad-hoc top-level `scripts/run-*.sh` loops for tests — add a thin wrapper under `test-suites/` and delegate to existing scripts so discovery stays in one place.
