#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3043: the generic worker-registry types defaulted TDeps to
# `any` (WorkerFactory / WorkerDefinition / WorkerRegistry / createWorkerRegistry).
# `any` silently disables type-checking of the injected `deps` whenever a caller
# omits the generic, so unsafe access to non-existent dependency fields compiles
# clean. The fix defaults TDeps to `unknown`, which keeps the same ergonomics for
# real callers (they still infer/assign fine) but forces explicit narrowing before
# `deps` is used.
#
# This repro compiles a small consumer that omits the generic and reads a field
# that does not exist on `deps`.
#   - Buggy `any` default  -> tsc succeeds (unsafe access leaks through) -> FAIL.
#   - Fixed `unknown` default -> tsc reports the unsafe access -> PASS.

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
REGISTRY_SRC="$REPO_ROOT/packages/execution-engine/src/worker-registry.ts"

if [[ ! -f "$REGISTRY_SRC" ]]; then
  echo "[repro] FAIL: cannot find worker-registry.ts at $REGISTRY_SRC"
  exit 1
fi

# Locate a TypeScript compiler. The repo install provides one under node_modules.
TSC=""
if [[ -x "$REPO_ROOT/node_modules/.bin/tsc" ]]; then
  TSC="$REPO_ROOT/node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC="$(command -v tsc)"
else
  echo "[repro] FAIL: no tsc found; run 'pnpm install' at the repo root first."
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Isolate the real registry source with a minimal WorkerRuntime stub so the
# compile check exercises the actual generic defaults without the full graph.
cp "$REGISTRY_SRC" "$WORK/worker-registry.ts"

cat > "$WORK/worker-runtime.ts" <<'EOF'
export interface WorkerRuntime {
  readonly identity: { readonly kind: string };
}
EOF

cat > "$WORK/consumer.ts" <<'EOF'
import { createWorkerRegistry } from './worker-registry.js';

// Caller omits the generic. Under `TDeps = any` this silently disables
// type-checking of `deps`; under `TDeps = unknown` reading an arbitrary field
// off `deps` must be a compile error.
const registry = createWorkerRegistry();
registry.register({
  kind: 'probe',
  note: 'probe worker',
  factory: (deps) => {
    const leaked = deps.thisFieldDoesNotExist;
    void leaked;
    return { identity: { kind: 'probe' } };
  },
});
EOF

cat > "$WORK/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
EOF

set +e
TSC_OUT="$("$TSC" -p "$WORK/tsconfig.json" 2>&1)"
TSC_CODE=$?
set -e

if [[ "$TSC_CODE" -eq 0 ]]; then
  echo "[repro] FAIL: unsafe 'deps' access compiled clean; worker-registry generics default TDeps to 'any'."
  exit 1
fi

if ! grep -q "thisFieldDoesNotExist\|of type 'unknown'" <<<"$TSC_OUT"; then
  echo "[repro] FAIL: tsc failed for an unexpected reason (setup issue), not the unsafe-deps access:"
  echo "$TSC_OUT"
  exit 1
fi

echo "[repro] PASS: worker-registry generics default TDeps to 'unknown'; unsafe 'deps' access is a compile error."
exit 0
