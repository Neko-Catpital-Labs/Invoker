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

Do **not** add ad-hoc top-level `scripts/run-*.sh` loops for tests — add a thin wrapper under `test-suites/` and delegate to existing scripts so discovery stays in one place.
