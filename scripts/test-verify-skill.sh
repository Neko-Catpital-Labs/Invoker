#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$REPO_ROOT/skills/verify/scripts/test-skill.sh"
python3 "$REPO_ROOT/scripts/run_skill_evals.py" validate --cases "$REPO_ROOT/evals/verify/cases.jsonl"
