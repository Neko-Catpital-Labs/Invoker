#!/usr/bin/env bash
# Vendors the plan-doctor's private dependency into
# skills/plan-to-invoker/scripts/vendor/, so lint-review-units.mjs works from
# ANY copy of the skills/ directory alone -- including a distributed
# invoker-cli / invoker-slack release tarball (scripts/archive-cli-binary.sh,
# scripts/archive-slack-binary.sh), which ship skills/ with no packages/, no
# node_modules, and no repo-root scripts/ directory alongside it.
#
# Vendored: scripts/review-unit-rules.mjs -- source of truth is this repo's
# own scripts/review-unit-rules.mjs, shared by several other repo-root
# scripts (validate-pr-body.mjs, check-pr-body-keywords.mjs, etc.), so it
# stays canonical at that path and is copied, not moved.
#
# The doctor's other out-of-tree dependency, the `yaml` npm package, is NOT
# vendored -- it's a real declared dependency of the published `invoker-cli`
# npm package (packages/npm-cli/package.json), so a plain `import 'yaml'`
# resolves it through npm's own install wherever that package lands. See
# validate-plan.mjs / lint-review-units.mjs for the resolution order.
#
# Run this whenever scripts/review-unit-rules.mjs changes.
# scripts/test-plan-to-invoker-skill.sh fails CI if the vendored copy drifts
# from its source.
#
# Usage: bash scripts/vendor-plan-doctor-deps.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR_DIR="skills/plan-to-invoker/scripts/vendor"

cp scripts/review-unit-rules.mjs "$VENDOR_DIR/review-unit-rules.mjs"

echo "Vendored review-unit-rules.mjs into $VENDOR_DIR/"
