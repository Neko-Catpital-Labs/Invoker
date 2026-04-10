# Invoker Architecture: Package Dependency Map

This document defines the allowed dependency directions in the Invoker codebase. The architecture is organized into 5 layers (0-4), where packages can only depend on packages in lower layers.

## Layer 0: Foundation (No Internal Dependencies)

These packages form the foundation and have no dependencies on other workspace packages.

- **contracts** — Core types and interfaces
- **workflow-graph** — Workflow graph data structures
- **transport** — Communication primitives
- **runtime-domain** — Runtime domain models
- **runtime-service** — Runtime service abstractions
- **shell** — Shell composition root
- **ui** — UI components

## Layer 1: Core Services (Depends on Layer 0 only)

- **workflow-core** → contracts, workflow-graph
- **protocol** → contracts
- **runtime-adapters** → runtime-domain
- **graph** → workflow-graph

## Layer 2: Data & Persistence (Depends on Layers 0-1)

- **data-store** → contracts, workflow-core
- **persistence** → workflow-core
- **core** → workflow-core

## Layer 3: Business Logic (Depends on Layers 0-2)

- **execution-engine** → contracts, persistence, workflow-core
- **surfaces** → contracts, data-store, transport, workflow-core

## Layer 4: Application & Testing (Depends on Layers 0-3)

- **test-kit** → contracts, execution-engine, workflow-core
- **app** → contracts, data-store, execution-engine, surfaces, transport, workflow-core

**test-kit** is a `private: true` utility package that provides shared test harnesses, in-memory persistence stubs, mock git helpers, and an in-memory message bus. It imports from contracts (Layer 0), workflow-core (Layer 1), and execution-engine (Layer 3). Because its highest dependency is Layer 3, Layer 4 is the correct placement with no risk of dependency cycles. test-kit is never published or deployed — it exists solely to reduce boilerplate across package test suites.

## Dependency Rules

### Allowed
- Packages may depend on packages in **lower** layers
- Packages may depend on packages in the **same** layer if no cycles are created
- External npm packages are allowed

### Forbidden
- Packages may **not** depend on packages in **higher** layers
- Circular dependencies are **not** allowed
- Orphaned modules should be removed

## Enforcement

The dependency rules are enforced through:

1. **dependency-cruiser** — Validates package boundaries at the module level
   - Run: `pnpm run check:deps`
   - Config: `.dependency-cruiser.js`

2. **TypeScript** — Validates type references and imports
   - Run: `pnpm run check:types` (alias for `tsc -b tsconfig.build.json`)
   - Config: `tsconfig.build.json`

3. **Owner Boundary Check** — Validates runtime persistence initialization
   - Run: `bash scripts/check-owner-boundary.sh`
   - Ensures `SQLiteAdapter.create()` stays in owner modules

4. **CI** — All checks run automatically on PRs and commits
   - See: `.github/workflows/ci.yml`

## Running All Checks

```bash
# Run all architecture checks
pnpm run check:all

# Or run individually
pnpm run check:deps     # dependency-cruiser
pnpm run check:types    # tsc -b
bash scripts/check-owner-boundary.sh  # owner boundary
```

## Visualizing Dependencies

Generate a visual dependency graph:

```bash
# Install graphviz if not already installed
# Ubuntu/Debian: sudo apt-get install graphviz
# macOS: brew install graphviz

# Generate graph
pnpm exec depcruise packages --config .dependency-cruiser.js --output-type dot | dot -T svg > deps.svg
```

## Adding New Packages

When adding a new package:

1. Determine which layer it belongs to based on its dependencies
2. Update the layer rules in `.dependency-cruiser.js` if needed
3. Add the package to the appropriate layer in this document
4. Run `pnpm run check:all` to verify compliance

## Migration Notes

This architecture was established during the package reorganization effort (workflow wf-1775366106244-5). The layered architecture prevents cycles and makes the system easier to understand and maintain.

### Previous State
Before this reorganization, the codebase had:
- Circular dependencies between packages
- Unclear ownership boundaries
- Mixed concerns in the `app` package

### Current State
The new architecture:
- Enforces a strict DAG (Directed Acyclic Graph)
- Separates concerns into clear layers
- Makes the composition root (`shell`) and application entry point (`app`) explicit
- Isolates persistence initialization to owner modules only
