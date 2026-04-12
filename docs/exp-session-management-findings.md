# Experiment: CLI Session Management Equivalence

**Date**: 2026-03-13
**Branch**: `experiment/experiment-cli-equivalence-exp-session-management-5322ccc6`
**Status**: 🔬 Research Complete

## Problem

Compare Claude Code's `--resume` flag with Cursor IDE's session management to understand session persistence, resumption, and state handling capabilities for CLI equivalence.

## Research Findings

### Claude Code Session Management

#### The `--resume` Flag

**Primary Interface**: `claude --resume [<session-id>]`

**Capabilities**:
- Interactive session picker when called without arguments
- Direct session resumption by UUID when called with session ID
- Alternative commands: `claude -c` (most recent), `claude -r "name"` (named sessions)

**Session Storage**:
- Location: `~/.claude/projects/<project>/sessions/<session-id>/`
- Identifier: UUID (e.g., `12345678-1234-1234-1234-123456789abc`)
- Project scoping: Derived from git repository root
- Full session history available via CLI (255+ sessions in reported cases)

**Session State**:
- Conversation history: Full message context preserved
- Permissions: Session-scoped permissions cleared on resume (re-prompts required)
- Working directory: Project-relative paths maintained
- Tools: Previous tool calls and results preserved in history

**Known Limitations (2026)**:
- In-session `/resume` command shows only ~5-10 recent sessions
- CLI `--resume` flag correctly shows full history (limitation is UI-specific)
- Issue #25130: Feature request to display full history in both contexts
- Issue #25729: Visibility limitation for older sessions in interactive picker

**Session ID Patterns** (from CLI output):
```
Session ID: <uuid>
sessionId=<uuid>
--session-id <uuid>
```

### Cursor IDE Session Management

#### Session Persistence

**Current State (Jan-Feb 2026)**:
- No native `--resume` equivalent flag
- CLI introduced in January 2026 with agent modes (Plan, Ask)
- Cloud handoff for background task execution
- Sessions created in IDE are NOT synced to CLI

**Requested Features** (not yet implemented):
- Automatic session resumption via `.cursor/chat_id` file
- Interactive prompt: "Resume previous session? (Y/n)" on Ctrl-C return
- IDE-to-CLI session sync (Issue #3846)

**Session Storage**:
- Location: Not publicly documented
- Format: Chat IDs (format unspecified)
- Persistence: Memory primarily stores short preference strings, not full context

**Workarounds**:
- Third-party tools (e.g., Basic Memory) provide persistent knowledge base
- Semantic search across notes and connections
- Survives session boundaries (external solution)

**Session ID Patterns** (hypothetical, based on output parsing tests):
```
Session: <uuid>
session_id=<uuid>
```

## Comparison Matrix

| Feature | Claude Code | Cursor IDE |
|---------|-------------|------------|
| **Resume Flag** | ✅ `--resume` | ❌ Not available |
| **Session ID Storage** | ✅ UUID in `~/.claude/projects/` | ⚠️ Chat IDs (location unspecified) |
| **CLI Session List** | ✅ Full history (255+) | ❌ No CLI listing |
| **Interactive Picker** | ✅ Yes (with UI limitations) | ❌ Not available |
| **Session Persistence** | ✅ Full message history + tools | ⚠️ Short preferences only |
| **IDE-CLI Sync** | ✅ Sessions work across both | ❌ Separate contexts |
| **Automatic Resume** | ❌ Manual only | ❌ Requested (#3846) |
| **Permission Persistence** | ❌ Cleared on resume | Unknown |
| **Cloud Handoff** | ❌ Not mentioned | ✅ Yes (Jan 2026) |

## Architecture Implications

### Invoker Implementation

From `packages/surfaces/src/slack/thread-session-manager.ts`:

**Current Session Management**:
- `SessionIdentifier`: Composite key `(channelId, threadTs)`
- Storage: `ConversationRepository` with SQLite backend
- TTL-based eviction: 30 minutes default
- Recovery: Full state reload from database via `init()`

**State Preserved**:
- Messages: Full conversation history
- Plan: Extracted plan YAML (if submitted)
- Metadata: `createdAt`, `updatedAt`, `userId`, `planSubmitted`
- Session handle: `PlanConversation` wrapper with lifecycle tracking

**Comparison to Claude/Cursor**:

| Aspect | Invoker | Claude | Cursor |
|--------|---------|--------|--------|
| **Identifier** | `(channel, thread)` composite | UUID | Chat ID |
| **Persistence** | SQLite (always-on) | Filesystem | Unknown |
| **Recovery** | Automatic via `getOrCreateSession()` | Manual `--resume` | Not available |
| **TTL Eviction** | Yes (30min) | No (manual cleanup) | Unknown |
| **Context Scope** | Slack thread | Project directory | IDE workspace |

## What "Done" Looks Like

**Research Phase** (Current):
✅ Documented Claude `--resume` capabilities
✅ Documented Cursor session limitations
✅ Compared session state handling
✅ Mapped to Invoker's existing architecture

**Testing Phase** (Next):
- Test Claude session creation and resumption
- Test session state persistence across restarts
- Test session ID extraction from CLI output
- Validate Cursor behavior when sessions are requested

## Alternatives Considered

### Alternative 1: Direct Testing (Not Chosen)
**Rationale**: Test actual CLI behavior with real sessions.

**Tradeoffs**:
- ✅ Empirical validation
- ❌ Requires Claude/Cursor installations
- ❌ Environment-dependent
- ❌ Harder to reproduce in CI

### Alternative 2: Mock-Based Testing (Not Chosen)
**Rationale**: Create stub CLIs that simulate session output.

**Tradeoffs**:
- ✅ Reproducible in CI
- ✅ Fast execution
- ❌ May not match real CLI behavior
- ❌ Maintenance burden for mocks

### Alternative 3: Documentation Review Only (Chosen)
**Rationale**: Research public docs and source code to understand behavior.

**Tradeoffs**:
- ✅ No dependencies
- ✅ Fast completion
- ✅ Sufficient for equivalence comparison
- ⚠️ Lacks empirical validation

## What This Cannot Be

- This is NOT an implementation of Cursor-compatible session management (Cursor doesn't have it)
- This is NOT a change to Invoker's session architecture (already works)
- This is NOT a proposal to add `--resume` flags to Invoker CLI (out of scope)
- This is NOT a test suite for third-party CLI session handling (documented behavior only)

## Blast Radius

**Scope**: Documentation only
- No code changes
- No tests added
- No configuration modified
- No production behavior affected

**Impact**: Zero risk (research deliverable)

## Verification

N/A - This is a research deliverable, not an implementation.

## Conclusions

### Key Findings

1. **Claude Code** has robust session management:
   - Native `--resume` flag with full history
   - UUID-based session IDs
   - Filesystem storage in `~/.claude/projects/`
   - Manual resumption with interactive picker

2. **Cursor IDE** lacks equivalent features:
   - No `--resume` flag as of Feb 2026
   - IDE-CLI session sync not available
   - Feature requests pending (auto-resume, session sync)
   - Relies on third-party tools for persistent context

3. **Invoker's session management** is more similar to Claude:
   - Automatic persistence (SQLite vs filesystem)
   - Composite identifiers (thread-based vs UUID)
   - TTL-based cleanup (proactive vs manual)
   - Recovery on demand (`getOrCreateSession()` vs `--resume`)

### Equivalence Assessment

**Claude Code**: ✅ Full support for session resumption
**Cursor IDE**: ❌ No session resumption support
**Invoker**: ✅ Automatic session recovery (different paradigm)

**Recommendation**: Invoker's session management already exceeds Cursor's capabilities and approaches Claude's model with automated recovery. No changes needed for equivalence with Cursor. Claude compatibility could be added by exposing session IDs and implementing a `--resume` equivalent, but this is out of current scope.

## Next Steps

If testing is required:
1. Create test plan for session persistence (see pending task)
2. Implement tests in `packages/executors/src/__tests__/cli-session-management.test.ts`
3. Validate session ID extraction patterns (Claude: 3 patterns, Cursor: 2 patterns)
4. Test state recovery across process restarts

If implementation is desired:
1. Add `--resume <session-id>` flag to Invoker CLI (if it exists)
2. Expose `ThreadSessionManager` sessions via CLI listing
3. Implement session ID output in task responses
4. Add `/resume` slash command for in-conversation session switching

## Revert Plan

```bash
git revert <commit-hash>
```

Removes documentation file. No production code affected.

## Sources

- [CLI reference - Claude Code Docs](https://code.claude.com/docs/en/cli-reference)
- [Claude Code Session Management | Steve Kinney](https://stevekinney.com/courses/ai-development/claude-code-session-management)
- [What is the --resume Flag in Claude Code | ClaudeLog](https://claudelog.com/faqs/what-is-resume-flag-in-claude-code/)
- [Session Management | DeepWiki](https://deepwiki.com/victor-software-house/claude-code-docs/3.2.2-session-management)
- [Session Control Flags | DeepWiki](https://deepwiki.com/FlorianBruniaux/claude-code-ultimate-guide/14.1-session-control-flags)
- [Issue #25130 - Allow /resume to display full session history](https://github.com/anthropics/claude-code/issues/25130)
- [Session Management and Resume | DeepWiki](https://deepwiki.com/FlorianBruniaux/claude-code-ultimate-guide/13.1-session-management-commands)
- [Claude Code Commands Cheat Sheet | 32blog](https://32blog.com/en/claude-code/claude-code-commands-cheatsheet)
- [Issue #25729 - /resume only shows ~5-10 recent sessions](https://github.com/anthropics/claude-code/issues/25729)
- [Cursor IDE February 2026 Updates](https://theagencyjournal.com/whats-new-in-cursor-february-2026-updates-that-actually-matter/)
- [Cursor CLI Release Discussion (Jan 16, 2026)](https://forum.cursor.com/t/cursor-cli-jan-16-2026/149172)
- [Issue #3846 - Automatic Session Resumption for Cursor Agent](https://github.com/cursor/cursor/issues/3846)
- [Add Persistent Memory to Cursor - Basic Memory](https://docs.basicmemory.com/integrations/cursor)
