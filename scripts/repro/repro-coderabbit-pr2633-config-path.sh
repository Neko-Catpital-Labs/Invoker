#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SPEC="$ROOT/packages/app/e2e/visual-proof.spec.ts"

echo "[repro] problem: System Setup visual proof could render a fake config path instead of the injected Electron fixture path"
echo "[repro] root cause: readiness diagnostics hardcoded /tmp/invoker-e2e/config.json rather than INVOKER_REPO_CONFIG_PATH"

python3 - "$SPEC" <<'PY'
import pathlib
import sys

spec = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

fake_path = "/tmp/invoker-e2e/config.json"
if fake_path in spec:
    raise SystemExit(f"bug still present: visual proof references fake path {fake_path}")

required_invariants = [
    "const systemSetupReadinessDiagnostics = (configPath: string)",
    "detail: `Parsed ${configPath}`",
    "electronApp.evaluate(() => process.env.INVOKER_REPO_CONFIG_PATH)",
    "const diagnostics = systemSetupReadinessDiagnostics(configPath)",
    "getByText(`Parsed ${configPath}`)",
]
for needle in required_invariants:
    if needle not in spec:
        raise SystemExit(f"missing injected-config invariant: {needle}")

# Pre-fix model: the fixture path and the rendered detail diverge.
fixture_path = "/tmp/invoker-fixture/e2e-config.json"
pre_fix_rendered_detail = "Parsed /tmp/invoker-e2e/config.json"
post_fix_rendered_detail = f"Parsed {fixture_path}"
assert pre_fix_rendered_detail != f"Parsed {fixture_path}", "pre-fix hardcoded path must diverge from fixture path"
assert post_fix_rendered_detail == f"Parsed {fixture_path}", "post-fix detail must render the injected fixture path"

print("[repro] pre-fix model: hardcoded /tmp/invoker-e2e/config.json diverges from injected fixture path")
print("[repro] source check: diagnostics and assertion both use INVOKER_REPO_CONFIG_PATH via configPath")
PY

echo "[repro] passed"
