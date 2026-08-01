## Summary

The embedded terminal always spawned pretending to be 80x24, then its real size arrived a moment later.

That real size came from a resize call the renderer never checked the result of.

A single dropped resize left the terminal permanently out of sync with whatever program was running inside it.

This slice adds plumbing two later fixes need: spawning at a real initial size, and reading back the size a terminal actually has right now.

## Review Claim

Approve that `TerminalSpec.cols`/`rows` flow through to the real PTY spawn call (falling back to 80x24 exactly as before when omitted), and that `EmbeddedTerminalManager.getAppliedSize` returns the PTY's live, authoritative size.

## Review Lane

refactor

## Review Unit

routing

## Safety Invariant

Every existing caller omits `cols`/`rows`, so every existing session still spawns at exactly 80x24 -- this is additive plumbing, not a default change.

## Slice Rationale

Kept apart from the renderer-side fix (next slice) so this backend piece can be reviewed and tested on its own before anything depends on it.

## Non-goals

No behavior change: nothing in the renderer calls the new applied-size channel yet, and no existing session's initial size changes.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `cd packages/app && pnpm test`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: `git revert <sha>`
- Post-revert steps: None
- Data migration? No

</details>

Depends-On: #6975
