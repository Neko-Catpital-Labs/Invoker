#!/usr/bin/env bash
set -euo pipefail

skill="$(cd "$(dirname "$0")/.." && pwd)/SKILL.md"

grep -Fq 'autoApproveAuthors' "$skill"
grep -Fq 'Do not enable the' "$skill"
grep -Fq 'skills/invoker-setup/SKILL.md' "$skill"
