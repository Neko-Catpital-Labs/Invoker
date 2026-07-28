#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== repro: admin requeue loader resolves YAML anchors and aliases =="
if PYTHONPATH=packages/mergify-admin-requeue python3 -m unittest \
  packages/mergify-admin-requeue/tests/test_mergify_admin_requeue.py \
  packages/mergify-admin-requeue/tests/test_mergify_admin_requeue_model.py
then
  echo "PASS: admin-bypass required checks still load from anchored Mergify config."
else
  echo "FAIL: admin-bypass required checks do not load from anchored Mergify config."
  exit 1
fi
