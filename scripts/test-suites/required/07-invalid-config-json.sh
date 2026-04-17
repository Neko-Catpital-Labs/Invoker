#!/usr/bin/env bash
# Guardrail: malformed config JSON must fail fast instead of silently defaulting.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-invalid-config.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

CONFIG_PATH="$TMP_DIR/bad-config.json"
cat > "$CONFIG_PATH" <<'EOF'
{
  "maxConcurrency": 6,
}
EOF

set +e
OUT_FILE="$TMP_DIR/output.txt"
node - "$CONFIG_PATH" >"$OUT_FILE" 2>&1 <<'EOF'
const { spawnSync } = require('node:child_process');

const configPath = process.argv[2];
const result = spawnSync('./run.sh', ['--headless', 'query', 'workflows'], {
  cwd: process.cwd(),
  env: { ...process.env, INVOKER_REPO_CONFIG_PATH: configPath },
  encoding: 'utf8',
  timeout: 15000,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== null) {
  process.exit(result.status);
}
if (result.signal) {
  process.exit(124);
}
process.exit(1);
EOF
EC=$?
OUT="$(cat "$OUT_FILE")"
set -e

if [[ "$EC" -eq 0 ]]; then
  echo "FAIL: expected malformed config JSON to fail startup"
  echo "$OUT"
  exit 1
fi

if ! grep -q "Invalid Invoker config JSON" <<<"$OUT"; then
  echo "FAIL: expected explicit invalid-config error"
  echo "$OUT"
  exit 1
fi

echo "PASS: malformed config JSON fails fast"
