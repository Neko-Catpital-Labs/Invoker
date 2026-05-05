# Architecture: Owner-Broker Model

## Overview

Invoker uses a single-writer owner model for database consistency. One process
(the **owner**) holds writable access to SQLite. All other processes
(**clients**) delegate mutations via IPC or open the database read-only.

Ownership is a **control-plane concept**, not a GUI/headless policy choice.
Any host surface—Electron GUI, headless CLI daemon, future TUI—can be the
owner. Client code never branches on how the owner was launched; it queries
capability predicates instead.

## Key Insight

```
┌──────────────────────────────────────────────────────┐
│                   Owner Process                       │
│  (single writer — may be GUI, standalone daemon,     │
│   or any future surface)                             │
│                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐   │
│  │ Persistence│  │ Orchestrator │  │ IPC Handler│   │
│  │ (writable) │  │              │  │            │   │
│  └────────────┘  └──────────────┘  └────────────┘   │
└──────────────────────────┬───────────────────────────┘
                           │ IPC (MessageBus)
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
    │  Client A │   │  Client B │   │  Client C │
    │ (CLI run) │   │ (CLI query│   │ (future   │
    │ delegates │   │  read-only│   │  surface) │
    │ mutations │   │  DB open) │   │           │
    └───────────┘   └───────────┘   └───────────┘
```

## Modules

| Module | Role | Key export |
|--------|------|------------|
| `owner-endpoint.ts` | Contract layer — defines what an owner looks like | `discoverOwner()`, `isStandaloneCapable()`, `isOwnerReachable()` |
| `owner-resolver.ts` | Resolution policy — discover, refresh, bootstrap | `createOwnerResolver()`, `OwnerResolver` interface |
| `headless-client.ts` | CLI entry point — routes commands | `runHeadlessClient()` |
| `headless-delegation.ts` | IPC transport — send commands to owner | `tryDelegateRun()`, `tryDelegateExec()`, `tryDelegateQuery()` |
| `headless-owner-bootstrap.ts` | Lifecycle — spawn detached owner | `spawnDetachedStandaloneOwner()`, `tryAcquireOwnerBootstrapLock()` |

## Command Routing

Three categories determine how a command reaches persistence:

### 1. Read-only queries

```
CLI → open DB with readOnly:true → return results
```

No delegation needed. Examples: `query workflows`, `query tasks`, `query audit`.

### 2. Standard mutations (default 5 s delegation timeout)

```
CLI → discoverOwner() → delegate via IPC → owner executes → response
      (if no owner: bootstrap standalone → retry)
```

Examples: `run`, `approve`, `reject`, `cancel`.

### 3. Workflow-scoped mutations (60 s delegation timeout)

Same routing as standard mutations, with an extended timeout because the
owner may be mid-operation (rebase, restart, recreate at workflow scope).

## Owner Resolution: Three Phases

`owner-resolver.ts` encapsulates a three-phase acquisition policy:

1. **Discover** — ping for a live owner via `discoverOwner()`.
2. **Refresh** — if no reply, reconnect the message bus and retry.
3. **Bootstrap** — if still unreachable, acquire a lock and spawn a
   standalone owner process, then poll until it responds to pings.

Clients call `resolver.resolve()` and receive either a `ResolvedOwner`
(bus handle + endpoint info) or a failure. The resolver handles retries,
timeouts, and lock contention internally.

## Capability Predicates (Not Mode Flags)

The contract layer exposes two predicates. Client code uses these instead
of inspecting raw `mode` strings:

| Predicate | Meaning |
|-----------|---------|
| `isOwnerReachable(result)` | An owner responded to ping (any surface) |
| `isStandaloneCapable(result)` | Owner accepts delegated mutations from peers |

This means adding a new surface (e.g., a TUI) requires no changes to client
routing logic—only the new surface must respond to `headless.owner-ping`
with appropriate capability flags.

## Where New Routing Logic Belongs

| Change | File |
|--------|------|
| New capability predicate | `owner-endpoint.ts` |
| New resolution strategy (e.g., cluster mode) | `owner-resolver.ts` |
| New CLI command that mutates | `headless-client.ts` (add delegation call) |
| New IPC channel or delegation shape | `headless-delegation.ts` |
| New owner spawn mechanism | `headless-owner-bootstrap.ts` |
| New surface (host implementation) | New entry in `main.ts` or equivalent; must handle `headless.owner-ping` |

## Design Principles

1. **Single writer.** Exactly one process writes to SQLite at any time.
2. **Delegate before bootstrap.** Always try IPC delegation first.
3. **Capability over mode.** Never branch on launch mode; use predicates.
4. **Bounded recovery.** Finite timeouts, capped retries, lock-protected
   bootstrap prevents thundering herd.
5. **Host neutrality.** The owner contract is the same regardless of which
   surface implements it. GUI, headless daemon, and future surfaces are
   interchangeable behind `OwnerEndpointInfo`.

## Related Documents

- [Persistence Architecture: Single-Writer Boundary](persistence-architecture-single-writer.md) —
  enforcement details, implementation map, CI policy checks.
