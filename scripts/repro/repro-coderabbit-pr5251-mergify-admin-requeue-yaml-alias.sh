#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== repro: admin requeue loader resolves YAML anchors and aliases =="
if PYTHONPATH="$ROOT/packages/mergify-admin-requeue${PYTHONPATH:+:$PYTHONPATH}" python3 - <<'PY'
import sys
import unittest

sys.path.insert(0, "packages/mergify-admin-requeue/tests")

from test_mergify_admin_requeue import MergifyAdminRequeueTests
from test_mergify_admin_requeue_model import MergifyRuleLoading

suite = unittest.TestSuite()
suite.addTest(MergifyAdminRequeueTests("test_loads_admin_bypass_rule_from_mergify_yml"))
suite.addTest(MergifyRuleLoading("test_reads_required_checks_from_yaml_alias"))
result = unittest.TextTestRunner().run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
PY
then
  echo "PASS: admin-bypass required checks still load from anchored Mergify config."
else
  echo "FAIL: admin-bypass required checks do not load from anchored Mergify config."
  exit 1
fi
