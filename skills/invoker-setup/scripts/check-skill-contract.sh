#!/usr/bin/env bash
set -euo pipefail

skill="$(cd "$(dirname "$0")/.." && pwd)/SKILL.md"

grep -q 'always-on harness instructions' "$skill"
grep -Fq 'unless the user says "do it locally"' "$skill"
grep -Fq '`install-skills uninstall`' "$skill"
grep -Fq 'does not delete the Invoker app or `~/.invoker`' "$skill"
