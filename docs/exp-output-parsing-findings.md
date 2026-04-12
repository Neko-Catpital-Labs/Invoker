# Experiment: CLI Output Parsing Equivalence

**Date**: 2026-03-13
**Branch**: `experiment/experiment-cli-equivalence-exp-output-parsing-dc1f6c35`
**Status**: ✅ Complete

## Problem

Validate that CLI output parsing in Invoker handles both Claude and Cursor CLI outputs consistently for success/failure states, error messages, and result summaries.

## Approach Considered

### Alternative 1: Recreate Full Test Suite (Chosen)
**Rationale**: Previous experiment validated 26 tests successfully. Recreating ensures ongoing test coverage and fulfills task requirements.

**Tradeoffs**:
- ✅ Comprehensive coverage of all edge cases
- ✅ Validates exit codes, error extraction, session IDs
- ✅ Tests match validated previous work
- ⚠️ More code than minimal validation

### Alternative 2: Minimal Validation
**Rationale**: Quick spot-check of key parsing behaviors.

**Tradeoffs**:
- ✅ Fast implementation
- ❌ Incomplete coverage
- ❌ Missing edge case validation

### Alternative 3: Skip (Already Validated)
**Rationale**: Previous experiment already validated equivalence.

**Tradeoffs**:
- ✅ Zero effort
- ❌ No ongoing test coverage
- ❌ Doesn't fulfill task requirement

## What This Cannot Be

- This is NOT a change to production parsing logic (WorktreeExecutor/DockerExecutor are already CLI-agnostic)
- This is NOT adding new CLI support (tests validate existing behavior)
- This is NOT changing exit code semantics (0 = success, non-zero = failure is standard)

## Implementation

### Files Created

**`packages/executors/src/__tests__/cli-output-parsing.test.ts`** (26 tests)

Test suites:
1. **Exit Code Parsing** (3 tests) - Validates 0 = success, non-zero = failure
2. **Error Message Extraction** (3 tests) - Parses stderr error patterns
3. **Session ID Extraction — Claude CLI** (4 tests) - Patterns: `Session ID:`, `sessionId=`, `--session-id`
4. **Session ID Extraction — Cursor CLI** (3 tests) - Patterns: `Session:`, `session_id=`
5. **Output Format Consistency** (2 tests) - stdout/stderr separation
6. **Claude CLI Fallback Behavior** (2 tests) - ENOENT detection and echo stub
7. **Result Summary Parsing** (3 tests) - Extract success/failure summaries
8. **WorkResponse Status Mapping** (3 tests) - Exit code → `completed`/`failed` mapping
9. **Edge Cases** (3 tests) - Long output (1000 lines), binary data, rapid interleaving

### Test Execution

```bash
cd packages/executors
pnpm test cli-output-parsing.test.ts
```

**Result**: ✅ 26/26 tests pass (59ms execution time)

### Key Validations

#### Exit Code Semantics
- Exit code 0 → `status: 'completed'`
- Exit code non-zero → `status: 'failed'`
- Signal termination → `status: 'failed'`

#### Session ID Extraction

**Claude CLI patterns** (case-insensitive):
```
Session ID: 12345678-1234-1234-1234-123456789abc
sessionId=12345678-1234-1234-1234-123456789abc
--session-id 12345678-1234-1234-1234-123456789abc
```

**Cursor CLI patterns** (case-insensitive):
```
Session: 12345678-1234-1234-1234-123456789abc
session_id=12345678-1234-1234-1234-123456789abc
```

#### Error Message Patterns
Supported error extraction:
- `Error: <message>`
- `Failed: <message>`
- `Exception: <message>`
- `ENOENT: <message>`
- `Permission denied: <message>`

#### Edge Cases Validated
1. **Very Long Output**: 1000 lines processed without truncation
2. **Binary Output**: Raw bytes handled without crashes
3. **Rapid Interleaving**: 50 stdout + 50 stderr writes processed correctly

## Architecture Notes

The current implementation in `WorktreeExecutor` and `DockerExecutor` is **CLI-agnostic**:

- Uses Node.js `spawn()` for process execution
- Captures stdout/stderr via event streams
- Maps exit codes: `exitCode === 0 ? 'completed' : 'failed'`
- No hardcoded CLI assumptions

This design allows seamless support for both Claude and Cursor CLIs without code changes.

## Blast Radius

**Scope**: Test-only addition
- No production code modified
- No changes to WorktreeExecutor, DockerExecutor, or BaseExecutor
- No API changes
- No configuration changes

**Impact**: Zero risk to production behavior

## Verification

```bash
cd packages/executors
pnpm test cli-output-parsing.test.ts
```

**Expected**: All 26 tests pass

## Conclusion

CLI output parsing in Invoker is **proven equivalent** for Claude and Cursor CLIs:

✅ Exit code detection (0 = success)
✅ Error message extraction from stderr
✅ Session ID extraction (multiple patterns)
✅ stdout/stderr separation
✅ Edge cases (long output, binary data, rapid writes)

**No production changes required** - existing parsing logic is CLI-agnostic and handles both CLIs correctly.

## Revert Plan

```bash
git revert <commit-hash>
```

Removes test file and documentation. Zero impact on production code.
