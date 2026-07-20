#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== repro: admin requeue loader resolves YAML anchors and aliases =="
if python3 -m unittest \
  scripts.test_mergify_admin_requeue.MergifyAdminRequeueTests.test_loads_admin_bypass_rule_from_mergify_yml \
  scripts.test_mergify_admin_requeue_model.MergifyRuleLoading.test_reads_required_checks_from_yaml_alias
then
  echo "PASS: admin-bypass required checks still load from anchored Mergify config."
else
  echo "FAIL: admin-bypass required checks do not load from anchored Mergify config."
  exit 1
fi
