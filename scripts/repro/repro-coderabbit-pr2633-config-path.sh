#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SPEC="$ROOT/packages/app/e2e/visual-proof.spec.ts"

echo "[repro] problem: System Setup visual proof could render a fake config path instead of the injected Electron fixture path"
echo "[repro] root cause: readiness diagnostics hardcoded /tmp/invoker-e2e/config.json rather than INVOKER_REPO_CONFIG_PATH"

python3 - "$SPEC" <<'PY'
import pathlib
import re
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

config_block_match = re.search(
    r"\{\s*id: 'config',\s*name: 'Config file',(?P<body>.*?)\n\s*\},",
    spec,
    re.S,
)
if not config_block_match:
    raise SystemExit("missing Config file readiness check block")

config_block = config_block_match.group("body")
if "detail: `Parsed ${configPath}`" not in config_block:
    raise SystemExit("Config file readiness detail must render the injected configPath")
if re.search(r"detail: ['\"]Parsed /", config_block):
    raise SystemExit("Config file readiness detail still renders a hardcoded absolute path")

print("[repro] pre-fix model: hardcoded /tmp/invoker-e2e/config.json is absent; spec renders `Parsed ${configPath}` dynamically")
print("[repro] source check: diagnostics and assertion both use INVOKER_REPO_CONFIG_PATH via configPath")
PY

echo "[repro] passed"
