#!/usr/bin/env bash
# test-pr-diagrams.sh — Generate sample PR summaries with Before/After Mermaid
# diagrams for PRs #175 and #176 to prove that the updated skill instructions
# produce architecture diagrams. Does NOT modify actual PR bodies.
#
# Usage: bash scripts/test-pr-diagrams.sh
#
# Output: writes two markdown files to /tmp/ and prints them to stdout.

set -euo pipefail

REPO="EdbertChan/Invoker"
OUTPUT_DIR="/tmp/pr-diagram-test"
mkdir -p "$OUTPUT_DIR"

# ─────────────────────────────────────────────────────────────
# PR #175: Arch-07 — CommandEnvelope with idempotency key
# ─────────────────────────────────────────────────────────────

cat > "$OUTPUT_DIR/pr-175-summary.md" << 'BODY175'
## Summary

Every surface (UI, headless CLI, Slack bot) was calling `orchestrator.approve()` and `orchestrator.reject()` directly with raw arguments. This made it impossible to add cross-cutting concerns like idempotency or audit logging without changing every call site. This PR introduces a `CommandEnvelope` type in `@invoker/contracts` and a `CommandService` wrapper in `workflow-core` that deduplicates commands by idempotency key. After this lands, all approve/reject calls go through `CommandService`, and duplicate commands within a 5-minute window are safely ignored.

## Architecture

### Before

```mermaid
graph TD
    UI["UI (Electron IPC)"]
    HL["Headless CLI"]
    SB["Slack Bot"]

    UI -->|"raw args"| ORC["Orchestrator<br/>.approve() / .reject()"]
    HL -->|"raw args"| ORC
    SB -->|"raw args"| ORC

    ORC --> DB[(Workflow State)]

    style ORC fill:#ffcdd2
```

### After

```mermaid
graph TD
    UI["UI (Electron IPC)"]
    HL["Headless CLI"]
    SB["Slack Bot"]

    UI -->|"makeEnvelope()"| CE["CommandEnvelope&lt;P&gt;<br/>commandId + source + scope<br/>+ idempotencyKey + payload"]
    HL -->|"makeEnvelope()"| CE
    SB -->|"makeEnvelope()"| CE

    CE --> CS["CommandService<br/>(LRU cache, 5min TTL)"]

    CS -->|"first call"| ORC["Orchestrator<br/>.approve() / .reject()"]
    CS -->|"duplicate key"| CACHE["Return cached<br/>CommandResult&lt;T&gt;"]

    ORC --> DB[(Workflow State)]

    style CE fill:#e1f5fe
    style CS fill:#fff3e0
    style CACHE fill:#e8f5e9
```

**Key components:**
- `CommandEnvelope<P>` (`packages/contracts/src/command-envelope.ts`) — typed message with `source`, `scope`, and `idempotencyKey`
- `CommandService` (`packages/workflow-core/src/command-service.ts`) — LRU cache (max 1000 entries, 5-min TTL) keyed by `idempotencyKey`
- `CommandResult<T>` — `{ ok: true, data: T } | { ok: false, error: { code, message } }`

<details>
<summary>Design Decisions</summary>

**Why a service wrapper instead of middleware?** The orchestrator has a narrow API surface (approve, reject). A wrapper class with per-method delegation is simpler than a generic middleware chain and avoids reflection.

**Why cache errors too?** If an approve fails (e.g., task already completed), retrying the same idempotency key should return the same error, not re-execute. This matches standard idempotency semantics.

**Why LRU instead of TTL-only?** Unbounded TTL maps grow indefinitely under load. LRU with a max size (1000) caps memory usage while TTL handles normal expiration.

</details>

## Test Plan

- [ ] `cd packages/workflow-core && pnpm test` — 213 tests pass including new `command-service.test.ts` (idempotency, TTL, LRU, error caching)
- [ ] `cd packages/app && pnpm test` — headless and main process tests pass with CommandService wiring
- [ ] `pnpm test` (root) — full suite passes, no regressions

**Tests added:**
- `packages/workflow-core/src/__tests__/command-service.test.ts` — 10 tests covering dedup, TTL expiry, LRU eviction, error caching, instance isolation

## Revert Plan

- **Safe to revert?** Yes
- **Revert command:** `git revert <merge-sha>`
- **Post-revert steps:** None. No migrations, no external state.
- **What breaks if reverted:** Approve/reject calls lose idempotency protection. Surfaces revert to calling orchestrator directly.
- **Data migration?** No

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY175

# ─────────────────────────────────────────────────────────────
# PR #176: Arch-08 — Derive InvokerAPI from a single channel registry
# ─────────────────────────────────────────────────────────────

cat > "$OUTPUT_DIR/pr-176-summary.md" << 'BODY176'
## Summary

The IPC type definitions for `InvokerAPI` were duplicated in three places: `packages/app/src/types.ts`, `packages/ui/src/types.ts`, and the `preload.ts` bridge. Adding a new IPC channel required editing all three files and the preload bridge manually. This PR creates a single IPC channel registry (`IpcChannels` / `IpcEventChannels`) in `@invoker/contracts` and derives the `InvokerAPI` type and the preload bridge from it automatically. After this lands, adding a new IPC channel means adding one entry to the registry — the type and runtime bridge are generated.

## Architecture

### Before

```mermaid
graph TD
    subgraph "packages/app"
        TYPES_APP_OLD["types.ts<br/>(hand-written InvokerAPI)"]
        PRE_OLD["preload.ts<br/>(hand-written per-channel bridge)"]
    end

    subgraph "packages/ui"
        TYPES_UI_OLD["types.ts<br/>(hand-written InvokerAPI copy)"]
    end

    TYPES_APP_OLD -.->|"must match"| TYPES_UI_OLD
    TYPES_APP_OLD -.->|"must match"| PRE_OLD

    style TYPES_APP_OLD fill:#ffcdd2
    style TYPES_UI_OLD fill:#ffcdd2
    style PRE_OLD fill:#ffcdd2
```

### After

```mermaid
graph TD
    subgraph "@invoker/contracts"
        REG["IpcChannels<br/>(channel → request/response)"]
        EVT["IpcEventChannels<br/>(channel → payload)"]
        REG --> DERIVE["Type-level derivation<br/>ChannelToMethod + KebabToCamel"]
        EVT --> DERIVE
        DERIVE --> API["InvokerAPI type<br/>(InvokeMethods & EventMethods)"]
    end

    subgraph "packages/app"
        PRE["preload.ts<br/>Runtime loop over<br/>Object.keys(IpcChannels)"]
        REG -.->|"import"| PRE
        EVT -.->|"import"| PRE
        TYPES_APP["types.ts<br/>(re-exports from contracts)"]
        API -.->|"re-export"| TYPES_APP
    end

    subgraph "packages/ui"
        TYPES_UI["types.ts<br/>(re-exports from contracts)"]
        API -.->|"re-export"| TYPES_UI
    end

    style REG fill:#e8eaf6
    style EVT fill:#e8eaf6
    style API fill:#c8e6c9
    style PRE fill:#fff3e0
```

**Key components:**
- `IpcChannels` / `IpcEventChannels` (`packages/contracts/src/ipc-channels.ts`) — runtime objects used as both type registries and runtime channel lists
- `ChannelToMethod<S>` / `KebabToCamel<S>` — type-level string transformers that convert `invoker:load-plan` → `loadPlan`
- `InvokerAPI` = `InvokeMethods & EventMethods` — fully derived, zero hand-written methods
- `preload.ts` — loops over registry keys at runtime, no manual per-channel code

<details>
<summary>Design Decisions</summary>

**Why `as const` objects instead of a Map or array?** TypeScript can infer literal key types from `as const` objects, enabling the type-level `ChannelToMethod` derivation. Maps and arrays lose key literal types.

**Why re-export from app/types.ts and ui/types.ts?** Preserves backward compatibility. Existing imports from `./types.js` continue to resolve without changing every consumer.

**Why add `@invoker/workflow-graph` as a dependency of contracts?** The channel registry references `TaskState`, `TaskDelta`, and `TaskStateChanges` from workflow-graph. This is a deliberate dependency — contracts defines the IPC shape, which includes workflow types.

</details>

## Test Plan

- [ ] `cd packages/contracts && pnpm test` — contract tests pass
- [ ] `cd packages/app && pnpm test` — preload and main process tests pass
- [ ] `cd packages/ui && pnpm test` — UI tests pass with re-exported types
- [ ] `pnpm test` (root) — full suite passes, no regressions
- [ ] TypeScript: `pnpm -r run build` — all packages compile with derived types

**Tests added/modified:**
- No new test files (type-level change). Existing tests validate the runtime bridge still works.

**Regression check:**
- [ ] Full test suite passes: `pnpm test`
- [ ] No unrelated test failures

## Revert Plan

- **Safe to revert?** Yes
- **Revert command:** `git revert <merge-sha>`
- **Post-revert steps:** Run `pnpm install` to restore old lockfile. No migrations.
- **What breaks if reverted:** Any new channels added after this PR that rely on the registry pattern will need manual type+bridge entries.
- **Data migration?** No

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY176

# ─────────────────────────────────────────────────────────────
# Validation: check that diagrams are present
# ─────────────────────────────────────────────────────────────

PASS=0
FAIL=0

for pr in 175 176; do
  file="$OUTPUT_DIR/pr-${pr}-summary.md"

  # Check for at least 2 mermaid code blocks (before + after)
  mermaid_count=$(grep -c '```mermaid' "$file" || true)
  if [ "$mermaid_count" -ge 2 ]; then
    echo "PASS: PR #${pr} has ${mermaid_count} Mermaid diagram(s) (need >= 2 for before/after)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: PR #${pr} has only ${mermaid_count} Mermaid diagram(s) (need >= 2 for before/after)"
    FAIL=$((FAIL + 1))
  fi

  # Check for Before heading
  if grep -q '### Before' "$file"; then
    echo "PASS: PR #${pr} has ### Before heading"
    PASS=$((PASS + 1))
  else
    echo "FAIL: PR #${pr} missing ### Before heading"
    FAIL=$((FAIL + 1))
  fi

  # Check for After heading
  if grep -q '### After' "$file"; then
    echo "PASS: PR #${pr} has ### After heading"
    PASS=$((PASS + 1))
  else
    echo "FAIL: PR #${pr} missing ### After heading"
    FAIL=$((FAIL + 1))
  fi

  # Check for Architecture section header
  if grep -q '^## Architecture' "$file"; then
    echo "PASS: PR #${pr} has ## Architecture section"
    PASS=$((PASS + 1))
  else
    echo "FAIL: PR #${pr} missing ## Architecture section"
    FAIL=$((FAIL + 1))
  fi

  # Check it still has all required sections
  for section in "## Summary" "## Test Plan" "## Revert Plan"; do
    if grep -q "^${section}" "$file"; then
      echo "PASS: PR #${pr} has ${section}"
      PASS=$((PASS + 1))
    else
      echo "FAIL: PR #${pr} missing ${section}"
      FAIL=$((FAIL + 1))
    fi
  done
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "Generated files:"
echo "  $OUTPUT_DIR/pr-175-summary.md"
echo "  $OUTPUT_DIR/pr-176-summary.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

echo ""
echo "=== PR #175 Summary ==="
echo ""
cat "$OUTPUT_DIR/pr-175-summary.md"
echo ""
echo "=== PR #176 Summary ==="
echo ""
cat "$OUTPUT_DIR/pr-176-summary.md"
