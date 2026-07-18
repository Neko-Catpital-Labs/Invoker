#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script_path="$repo_root/scripts/repro/repro-downstream-gate-blind-to-db-completed-upstream.sh"

cd "$repo_root"

echo "[repro] Problem: the real-SQLite gate repro could print one DB path but test a different hidden tmp DB."
echo "[repro] Check: the generated Vitest snippet must use INVOKER_DB_DIR, not mkdtemp/tmpdir."

python3 - "$script_path" <<'PY'
import pathlib
import sys

script = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

for forbidden in (
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "const dbDir = mkdtempSync(join(tmpdir(), 'invoker-gate-db-vs-memory-'));",
    "process.env.INVOKER_DB_DIR = dbDir;",
):
    if forbidden in script:
        raise SystemExit(f"bug still present: found forbidden snippet: {forbidden}")

required = [
    "const dbDir = process.env.INVOKER_DB_DIR;",
    "throw new Error('INVOKER_DB_DIR is required');",
    "const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });",
    'echo "temporary_db_dir=$DB_DIR"',
    'echo "command=INVOKER_DB_DIR=$DB_DIR ',
    'INVOKER_DB_DIR="$DB_DIR" ',
]
for needle in required:
    if needle not in script:
        raise SystemExit(f"missing invariant: {needle}")

print("[repro] PASS: the printed DB path and the Vitest DB path stay on the same INVOKER_DB_DIR contract")
PY
